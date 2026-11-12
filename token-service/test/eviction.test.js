// A moderator removes someone from a group conversation while its call runs
// (ORISO-Admin#1518 follow-up). The Matrix ban stops new call tokens, but the
// person's live LiveKit connection stayed. UserService now asks this gateway
// to take them out of the call's LiveKit room.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createServer } = require("node:http");
const {
  createEviction,
  liveKitRoomAliasFor,
  CALL_SLOT,
} = require("../eviction");

const TOKEN = "t".repeat(40);
const MEDIA_ROOM = "!media:oriso.test";

function fakeRooms(participantsByRoom) {
  const state = { removed: [], rooms: participantsByRoom };
  return {
    state,
    async listParticipants(room) {
      if (state.listFails) throw new Error("livekit down");
      return (state.rooms[room] || []).map((identity) => ({ identity }));
    },
    async removeParticipant(room, identity) {
      state.removed.push([room, identity]);
      if (!state.keepAfterRemove)
        state.rooms[room] = state.rooms[room].filter((i) => i !== identity);
    },
    async getParticipant(room, identity) {
      if ((state.rooms[room] || []).includes(identity)) return { identity };
      const e = new Error("not found");
      e.code = "not_found";
      throw e;
    },
  };
}

test("room alias matches lk-jwt-service's spec test vector", () => {
  assert.equal(
    liveKitRoomAliasFor("!roomid:example.com", "slot1234"),
    "O8437W3+jmzMVjoIP3tNwbm+XxHQk2iKpOA7aqw3qSc",
  );
  assert.equal(CALL_SLOT, "m.call#ROOM");
});

test("removes every device of the removed person from the call, nobody else", async () => {
  const alias = liveKitRoomAliasFor(MEDIA_ROOM, CALL_SLOT);
  const rooms = fakeRooms({
    [alias]: [
      "@anna:oriso.test:PHONE",
      "@anna:oriso.test:LAPTOP",
      "@anna:oriso.test:DEV:ICE",
      "@annabel:oriso.test:Y",
      "@anna:oriso.test.evil:X",
      "@bea:oriso.test:DESK",
    ],
  });
  const eviction = createEviction({ token: TOKEN, rooms });

  const removed = await eviction.evict("@anna:oriso.test", [MEDIA_ROOM]);

  assert.equal(removed, 3);
  assert.deepEqual(rooms.state.rooms[alias], [
    "@annabel:oriso.test:Y",
    "@anna:oriso.test.evil:X",
    "@bea:oriso.test:DESK",
  ]);
});

test("a call nobody is in is not an error", async () => {
  const eviction = createEviction({ token: TOKEN, rooms: fakeRooms({}) });
  assert.equal(await eviction.evict("@anna:oriso.test", [MEDIA_ROOM]), 0);
});

test("fails loudly when the participant is still there after removal", async () => {
  const alias = liveKitRoomAliasFor(MEDIA_ROOM, CALL_SLOT);
  const rooms = fakeRooms({ [alias]: ["@anna:oriso.test:PHONE"] });
  rooms.state.keepAfterRemove = true;
  const eviction = createEviction({ token: TOKEN, rooms });

  await assert.rejects(() =>
    eviction.evict("@anna:oriso.test", [MEDIA_ROOM]),
  );
});

test("refuses a weak shared secret", () => {
  assert.throws(() => createEviction({ token: "short", rooms: fakeRooms({}) }));
});

async function serve(t, rooms) {
  const app = express();
  app.use(express.json());
  createEviction({ token: TOKEN, rooms }).mount(app);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/internal/matrixrtc/evict`;
  return (body, token = TOKEN) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
}

test("endpoint: 403 without the shared secret, nothing removed", async (t) => {
  const alias = liveKitRoomAliasFor(MEDIA_ROOM, CALL_SLOT);
  const rooms = fakeRooms({ [alias]: ["@anna:oriso.test:PHONE"] });
  const post = await serve(t, rooms);

  const res = await post(
    { matrixUserId: "@anna:oriso.test", mediaRoomIds: [MEDIA_ROOM] },
    "x".repeat(40),
  );

  assert.equal(res.status, 403);
  assert.deepEqual(rooms.state.removed, []);
});

test("endpoint: 204 after removal", async (t) => {
  const alias = liveKitRoomAliasFor(MEDIA_ROOM, CALL_SLOT);
  const rooms = fakeRooms({ [alias]: ["@anna:oriso.test:PHONE"] });
  const post = await serve(t, rooms);

  const res = await post({
    matrixUserId: "@anna:oriso.test",
    mediaRoomIds: [MEDIA_ROOM],
  });

  assert.equal(res.status, 204);
  assert.deepEqual(rooms.state.removed, [[alias, "@anna:oriso.test:PHONE"]]);
});

test("endpoint: 400 for a malformed request", async (t) => {
  const post = await serve(t, fakeRooms({}));
  for (const body of [
    {},
    { matrixUserId: "anna", mediaRoomIds: [MEDIA_ROOM] },
    { matrixUserId: "@anna:oriso.test", mediaRoomIds: [] },
    { matrixUserId: "@anna:oriso.test", mediaRoomIds: ["not-a-room"] },
    {
      matrixUserId: "@anna:oriso.test",
      mediaRoomIds: Array.from({ length: 21 }, (_, i) => `!r${i}:oriso.test`),
    },
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
});

test("endpoint: 503 when LiveKit cannot be reached, so the caller retries", async (t) => {
  const rooms = fakeRooms({});
  rooms.state.listFails = true;
  const post = await serve(t, rooms);

  const res = await post({
    matrixUserId: "@anna:oriso.test",
    mediaRoomIds: [MEDIA_ROOM],
  });

  assert.equal(res.status, 503);
});

test("the image ships every module server.js requires", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const root = join(__dirname, "..");
  const server = readFileSync(join(root, "server.js"), "utf8");
  const copied = readFileSync(join(root, "Dockerfile"), "utf8");
  for (const [, mod] of server.matchAll(/require\('\.\/([\w-]+)'\)/g))
    assert.match(copied, new RegExp(`COPY [^\\n]*\\b${mod}\\.js\\b`), mod);
});
