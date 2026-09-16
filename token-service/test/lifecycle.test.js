const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { AccessToken } = require("livekit-server-sdk");
const { createLifecycle } = require("../lifecycle");

async function fixture(t) {
  const state = {
    active: true,
    present: true,
    removeFails: false,
    removals: 0,
    policyFails: false,
    unknown: false,
  };
  const external = createServer(async (req, res) => {
    if (req.url === "/policy") {
      res.writeHead(state.policyFails ? 503 : state.active ? 204 : 403);
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/ListRooms")) {
      res.end(JSON.stringify({ rooms: [{ name: "room-one" }] }));
      return;
    }
    if (req.url.endsWith("/ListParticipants")) {
      res.end(
        JSON.stringify({
          participants: [
            ...(state.present ? [{ identity: "opaque-alice" }] : []),
            ...(state.unknown ? [{ identity: "legacy-unknown" }] : []),
          ],
        }),
      );
      return;
    }
    if (req.url.endsWith("/RemoveParticipant")) {
      state.removals++;
      if (state.blockRemoval) await state.blockRemoval();
      if (state.removeFails) {
        res.writeHead(503);
        res.end(JSON.stringify({ code: "unavailable", msg: "retry" }));
        return;
      }
      if (request.identity === "legacy-unknown") state.unknown = false;
      else state.present = false;
      res.end("{}");
      return;
    }
    if (req.url.endsWith("/GetParticipant")) {
      if (
        request.identity === "legacy-unknown" ? state.unknown : state.present
      ) {
        res.end(JSON.stringify({ identity: "opaque-alice" }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ code: "not_found", msg: "gone" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((r) => external.listen(0, "127.0.0.1", r));
  const policyUrl = `http://127.0.0.1:${external.address().port}/policy`;
  const config = {
    redisUrl: process.env.LIFECYCLE_TEST_REDIS_URL,
    namespace: randomUUID(),
    apiKey: "test-key",
    apiSecret: "test-secret-at-least-32-characters",
    sharedSecret: "separate-internal-secret-at-least-32-characters",
    policyUrl,
    livekitUrl: new URL(policyUrl).origin,
    reconcileIntervalMs: 50,
  };
  const lifecycle = await createLifecycle(config);
  const app = express();
  lifecycle.mount(app);
  app.use(express.json());
  // Token delivery boundary: registration must finish before a token becomes observable.
  app.post("/issue", async (req, res) => {
    try {
      await lifecycle.registerIssued(req.body.jwt, "@alice:matrix.test");
      res.json({ jwt: req.body.jwt });
    } catch {
      res.sendStatus(503);
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await lifecycle.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => external.close(r));
  });
  const token = new AccessToken(
    "test-key",
    "test-secret-at-least-32-characters",
    { identity: "opaque-alice", ttl: "1h" },
  );
  token.addGrant({ roomJoin: true, room: "room-one" });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    jwt: await token.toJwt(),
    lifecycle,
    state,
    config,
  };
}
test("unknown participant tokens fail closed; registered signed tokens require current ACTIVE policy", async (t) => {
  const f = await fixture(t);
  const admit = () =>
    fetch(f.url + "/internal/lifecycle/admit", {
      headers: { "x-original-uri": "/livekit/sfu/rtc?access_token=" + f.jwt },
    });
  assert.equal((await admit()).status, 403);
  assert.equal(
    (
      await fetch(f.url + "/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jwt: f.jwt }),
      })
    ).status,
    200,
  );
  assert.equal((await admit()).status, 204);
});

test("durable revocation denies old JWT despite remote removal failure and retries before confirming absence", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  const revoke = (secret = "separate-internal-secret-at-least-32-characters") =>
    fetch(f.url + "/internal/lifecycle/revoke", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + secret,
      },
      body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
    });
  assert.equal((await revoke("wrong")).status, 403);
  assert.equal(f.state.removals, 0);
  f.state.removeFails = true;
  assert.equal((await revoke()).status, 503);
  assert.equal(
    (
      await fetch(f.url + "/internal/lifecycle/admit", {
        headers: { "x-original-uri": "/rtc?access_token=" + f.jwt },
      })
    ).status,
    403,
  );
  const refreshed = new AccessToken(
    "test-key",
    "test-secret-at-least-32-characters",
    { identity: "opaque-alice", ttl: "2h" },
  );
  refreshed.addGrant({ roomJoin: true, room: "room-one" });
  assert.equal(
    (
      await fetch(f.url + "/internal/lifecycle/admit", {
        headers: {
          "x-original-uri": "/rtc?access_token=" + (await refreshed.toJwt()),
        },
      })
    ).status,
    403,
  );
  f.state.removeFails = false;
  assert.equal((await revoke()).status, 204);
  assert.equal(f.state.present, false);
  assert.equal(
    (
      await fetch(f.url + "/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jwt: f.jwt }),
      })
    ).status,
    503,
  );
});

test("signed late-join webhook removes revoked participant; unsigned events do not act", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  await fetch(f.url + "/internal/lifecycle/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer separate-internal-secret-at-least-32-characters",
    },
    body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
  });
  f.state.present = true;
  const body = JSON.stringify({
    event: "participant_joined",
    room: { name: "room-one" },
    participant: { identity: "opaque-alice" },
  });
  const before = f.state.removals;
  assert.equal(
    (
      await fetch(f.url + "/internal/lifecycle/webhook", {
        method: "POST",
        headers: { "content-type": "application/webhook+json" },
        body,
      })
    ).status,
    403,
  );
  assert.equal(f.state.removals, before);
  const token = new AccessToken(
    "test-key",
    "test-secret-at-least-32-characters",
  );
  token.sha256 = require("node:crypto")
    .createHash("sha256")
    .update(body)
    .digest("base64");
  assert.equal(
    (
      await fetch(f.url + "/internal/lifecycle/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/webhook+json",
          authorization: await token.toJwt(),
        },
        body,
      })
    ).status,
    204,
  );
  assert.equal(f.state.present, false);
});

test("persistent denied identities reconcile late arrivals after gateway restart", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  await fetch(f.url + "/internal/lifecycle/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer separate-internal-secret-at-least-32-characters",
    },
    body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
  });
  await f.lifecycle.close();
  f.state.present = true;
  const restarted = await createLifecycle(f.config);
  t.after(() => restarted.close());
  for (let i = 0; i < 30 && f.state.present; i++)
    await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.state.present, false);
});

test("explicit restoration clears denial but admission stays closed until policy becomes ACTIVE", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  const change = (path) =>
    fetch(f.url + "/internal/lifecycle/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer separate-internal-secret-at-least-32-characters",
      },
      body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
    });
  await change("revoke");
  f.state.active = false;
  assert.equal((await change("restore")).status, 204);
  const admit = () =>
    fetch(f.url + "/internal/lifecycle/admit", {
      headers: { "x-original-uri": "/rtc?access_token=" + f.jwt },
    });
  assert.equal((await admit()).status, 403);
  f.state.active = true;
  assert.equal((await admit()).status, 204);
});

test("tampered JWT, cross-room JWT and policy outage never admit registered participant", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  const admit = (jwt) =>
    fetch(f.url + "/internal/lifecycle/admit", {
      headers: { "x-original-uri": "/rtc?access_token=" + jwt },
    });
  assert.equal((await admit(f.jwt.slice(0, -8) + "tampered")).status, 403);
  const token = new AccessToken(
    "test-key",
    "test-secret-at-least-32-characters",
    { identity: "opaque-alice", ttl: "1h" },
  );
  token.addGrant({ roomJoin: true, room: "another-room" });
  assert.equal((await admit(await token.toJwt())).status, 403);
  f.state.policyFails = true;
  assert.equal((await admit(f.jwt)).status, 503);
});

test("unregistered pre-rollout participants keep revocation pending without disconnecting unrelated calls", async (t) => {
  const f = await fixture(t);
  f.state.present = false;
  f.state.unknown = true;
  const r = await fetch(f.url + "/internal/lifecycle/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer separate-internal-secret-at-least-32-characters",
    },
    body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
  });
  assert.equal(r.status, 503);
  assert.equal(f.state.unknown, true);
  assert.equal(f.state.removals, 0);
});

test("known target disconnects even when unrelated unknown participant keeps completion pending", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  f.state.unknown = true;
  const r = await fetch(f.url + "/internal/lifecycle/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer separate-internal-secret-at-least-32-characters",
    },
    body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
  });
  assert.equal(r.status, 503);
  assert.equal(f.state.present, false);
  assert.equal(f.state.unknown, true);
});

test("restoration during blocked background removal never recreates the durable deny", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  const change = (path) =>
    fetch(f.url + "/internal/lifecycle/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer separate-internal-secret-at-least-32-characters",
      },
      body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
    });
  await change("revoke");
  let entered, release;
  const started = new Promise((r) => (entered = r));
  const blocked = new Promise((r) => (release = r));
  f.state.blockRemoval = async () => {
    entered();
    await blocked;
  };
  f.state.present = true;
  try {
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("no reconciliation")), 1000),
      ),
    ]);
    assert.equal((await change("restore")).status, 204);
  } finally {
    release();
    f.state.blockRemoval = null;
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    (
      await fetch(f.url + "/internal/lifecycle/admit", {
        headers: { "x-original-uri": "/rtc?access_token=" + f.jwt },
      })
    ).status,
    204,
  );
});

test("successful deletion forgets personal mappings while bounded redacted tombstones catch missed late-join webhooks", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  f.state.active = false;
  const forget = () =>
    fetch(f.url + "/internal/lifecycle/forget", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer separate-internal-secret-at-least-32-characters",
      },
      body: JSON.stringify({ matrixUserIds: ["@alice:matrix.test"] }),
    });
  assert.equal((await forget()).status, 204);
  assert.equal((await forget()).status, 204);
  const redis = require("redis").createClient({ url: f.config.redisUrl });
  await redis.connect();
  try {
    const keys = await redis.keys(
      "matrixrtc:lifecycle:" + f.config.namespace + ":*",
    );
    assert.equal(keys.length, 1);
    assert.match(keys[0], /:forgotten:[a-f0-9]{64}$/);
    assert.equal(await redis.get(keys[0]), "1");
    const ttl = await redis.ttl(keys[0]);
    assert.ok(ttl > 0 && ttl <= 86400);
  } finally {
    await redis.quit();
  }
  assert.equal(
    (
      await fetch(f.url + "/internal/lifecycle/admit", {
        headers: { "x-original-uri": "/rtc?access_token=" + f.jwt },
      })
    ).status,
    403,
  );
  f.state.present = true;
  for (let i = 0; i < 30 && f.state.present; i++)
    await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.state.present, false);
});

test("lifecycle rejects a shared secret shorter than 32 characters at startup", async (t) => {
  const f = await fixture(t);
  await assert.rejects(async () => {
    const invalid = await createLifecycle({
      ...f.config,
      sharedSecret: "short",
    });
    await invalid.close();
  }, /32/);
});

test("conflicting query and header tokens cannot authorize a different SFU participant", async (t) => {
  const f = await fixture(t);
  await fetch(f.url + "/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: f.jwt }),
  });
  const token = new AccessToken(
    "test-key",
    "test-secret-at-least-32-characters",
    { identity: "another-person", ttl: "1h" },
  );
  token.addGrant({ roomJoin: true, room: "room-one" });
  const r = await fetch(f.url + "/internal/lifecycle/admit", {
    headers: {
      "x-original-uri": "/rtc?access_token=" + f.jwt,
      authorization: "Bearer " + (await token.toJwt()),
    },
  });
  assert.equal(r.status, 403);
});
