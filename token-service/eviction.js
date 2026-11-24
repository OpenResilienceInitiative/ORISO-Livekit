// Moderator removal from a running call (ORISO-Admin#1518 follow-up).
//
// A moderator's "remove" bans the person from the group conversation's
// Matrix room. That already stops new call tokens (the call policy needs room
// membership), but a LiveKit connection that is already open stays. UserService
// calls this endpoint after the ban, with the call's Matrix media room(s), and
// the gateway removes that person's participants from the LiveKit room.
//
// Element Call joins through lk-jwt-service's legacy `/sfu/get`, which names
// the LiveKit room `LiveKitRoomAliasFor(mediaRoomId, "m.call#ROOM")` and the
// participant `<matrixUserId>:<deviceId>` (element-hq/lk-jwt-service
// a375b130, handler.go). The alias is ported below and pinned by the spec
// test vector in test/eviction.test.js.
//
// Limits (need the lifecycle admit gate, MATRIXRTC_LIFECYCLE_ENABLED, to
// close): a modified client could reconnect with its still-valid JWT (1 h),
// and a participant that joined through `/get_token` has a hashed identity
// this cannot match. The ORISO app leaves the call on the ban by itself.
//
// Independent of the account lifecycle module: it removes one person from
// the given calls only, it does not deny them anywhere else.
const { createHash, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { RoomServiceClient } = require("livekit-server-sdk");

const CALL_SLOT = "m.call#ROOM";
const MAX_ROOMS = 20;
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/;
const MATRIX_ROOM_ID = /^![^:\s]+:[^\s]+$/;

// Go's json.Marshal escapes <, > and & where JSON.stringify does not; Matrix
// ids never contain them, and the request validation rejects any that would.
const liveKitRoomAliasFor = (matrixRoomId, slot) =>
  createHash("sha256")
    .update(JSON.stringify([matrixRoomId, slot]))
    .digest("base64")
    .replace(/=+$/, "");

const isNotFound = (error) => error?.code === "not_found";

function createEviction({ token, rooms }) {
  if (typeof token !== "string" || token.length < 32)
    throw new Error("Eviction shared secret must contain at least 32 characters");

  async function evict(matrixUserId, mediaRoomIds) {
    const prefix = matrixUserId + ":";
    let removed = 0;
    for (const mediaRoomId of mediaRoomIds) {
      const room = liveKitRoomAliasFor(mediaRoomId, CALL_SLOT);
      let participants;
      try {
        participants = await rooms.listParticipants(room);
      } catch (error) {
        if (isNotFound(error)) continue; // no call running in that room
        throw error;
      }
      for (const { identity } of participants) {
        if (typeof identity !== "string" || !identity.startsWith(prefix))
          continue;
        // `@anna:hs:` + any device id (which may itself contain ':'); the
        // trailing ':' keeps `@anna:hs.evil:X` and `@annabel:hs:X` out.
        if (identity.length === prefix.length) continue;
        try {
          await rooms.removeParticipant(room, identity);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        try {
          await rooms.getParticipant(room, identity);
        } catch (error) {
          if (isNotFound(error)) {
            removed++;
            continue;
          }
          throw error;
        }
        throw new Error("Participant still present");
      }
    }
    return removed;
  }

  function authorized(req) {
    const actual = Buffer.from(req.get("authorization") || "");
    const expected = Buffer.from("Bearer " + token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function validRequest(body) {
    return (
      body &&
      typeof body.matrixUserId === "string" &&
      MATRIX_USER_ID.test(body.matrixUserId) &&
      Array.isArray(body.mediaRoomIds) &&
      body.mediaRoomIds.length > 0 &&
      body.mediaRoomIds.length <= MAX_ROOMS &&
      body.mediaRoomIds.every(
        (id) => typeof id === "string" && MATRIX_ROOM_ID.test(id) && !/[<>&]/.test(id),
      ) &&
      !/[<>&]/.test(body.matrixUserId)
    );
  }

  function mount(app) {
    app.post("/internal/matrixrtc/evict", async (req, res) => {
      if (!authorized(req)) return res.sendStatus(403);
      if (!validRequest(req.body)) return res.sendStatus(400);
      try {
        await evict(req.body.matrixUserId, [...new Set(req.body.mediaRoomIds)]);
        return res.sendStatus(204);
      } catch {
        // Never echo LiveKit errors; the caller retries on 503.
        return res.sendStatus(503);
      }
    });
  }

  return { evict, mount };
}

// Disabled (route absent, 404) unless the LiveKit RoomService is configured.
function createEvictionFromEnvironment(env = process.env) {
  const livekitUrl = env.MATRIXRTC_EVICTION_LIVEKIT_URL?.trim();
  if (!livekitUrl) return null;
  const url = new URL(livekitUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("MATRIXRTC_EVICTION_LIVEKIT_URL must use HTTP or HTTPS");
  const read = (name) => {
    const path = env[name]?.trim();
    if (!path) throw new Error(`${name} must be configured`);
    const value = readFileSync(path, "utf8").trim();
    if (!value) throw new Error(`${name} is empty`);
    return value;
  };
  return createEviction({
    token: read("MATRIXRTC_EVICTION_TOKEN_FILE"),
    rooms: new RoomServiceClient(
      url.origin,
      read("MATRIXRTC_EVICTION_LIVEKIT_KEY_FILE"),
      read("MATRIXRTC_EVICTION_LIVEKIT_SECRET_FILE"),
      { requestTimeout: 3 },
    ),
  });
}

module.exports = {
  CALL_SLOT,
  createEviction,
  createEvictionFromEnvironment,
  liveKitRoomAliasFor,
};
