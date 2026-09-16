const express = require("express");
const { createHash, timingSafeEqual } = require("node:crypto");
const { createClient } = require("redis");
const {
  TokenVerifier,
  RoomServiceClient,
  WebhookReceiver,
} = require("livekit-server-sdk");

async function createLifecycle(config) {
  if (
    typeof config.sharedSecret !== "string" ||
    config.sharedSecret.length < 32
  )
    throw new Error(
      "Lifecycle shared secret must contain at least 32 characters",
    );
  if (!config.redisUrl) throw new Error("Lifecycle Redis URL is required");
  const redis = createClient({
    url: config.redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 2000),
    },
  });
  redis.on("error", () => {});
  await redis.connect();
  const prefix = `matrixrtc:lifecycle:${config.namespace || "v1"}:`;
  const rooms = new RoomServiceClient(
    config.livekitUrl,
    config.apiKey,
    config.apiSecret,
    { requestTimeout: 3 },
  );
  const webhook = new WebhookReceiver(config.apiKey, config.apiSecret);
  const verifier = new TokenVerifier(config.apiKey, config.apiSecret);
  const key = (room, identity) =>
    createHash("sha256")
      .update(JSON.stringify([room, identity]))
      .digest("hex");
  async function claims(jwt) {
    const c = await verifier.verify(jwt, 0);
    if (
      typeof c.sub !== "string" ||
      c.video?.roomJoin !== true ||
      typeof c.video.room !== "string" ||
      !Number.isFinite(c.exp)
    )
      throw new Error("Invalid participant grant");
    return c;
  }
  async function active(matrixUserId) {
    const r = await fetch(config.policyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-matrixrtc-lifecycle-token": config.sharedSecret,
      },
      body: JSON.stringify({ matrixUserId }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.status === 204) return true;
    if (r.status === 403) return false;
    throw new Error("Lifecycle policy unavailable");
  }
  async function registerIssued(jwt, matrixUserId) {
    if (typeof matrixUserId !== "string" || !matrixUserId.startsWith("@"))
      throw new Error("Invalid Matrix identity");
    const c = await claims(jwt);
    if (!(await active(matrixUserId))) throw new Error("Inactive identity");
    const id = key(c.video.room, c.sub);
    const saved = await redis.eval(
      `if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 0 end
    local existing=redis.call('HGET', KEYS[2], ARGV[2]); if existing and cjson.decode(existing).matrixUserId ~= ARGV[1] then return 0 end
    redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]); redis.call('SADD', KEYS[3], ARGV[2]); return 1`,
      {
        keys: [
          prefix + "denied",
          prefix + "participants",
          prefix + "user:" + key(matrixUserId, ""),
        ],
        arguments: [
          matrixUserId,
          id,
          JSON.stringify({ room: c.video.room, identity: c.sub, matrixUserId }),
        ],
      },
    );
    if (saved !== 1) throw new Error("Revoked identity");
  }
  async function remove(record) {
    try {
      await rooms.removeParticipant(record.room, record.identity);
    } catch (e) {
      if (e.code !== "not_found") throw e;
    }
    try {
      await rooms.getParticipant(record.room, record.identity);
    } catch (e) {
      if (e.code === "not_found") return;
      throw e;
    }
    throw new Error("Participant still present");
  }
  async function revoke(matrixUserIds) {
    await redis.sAdd(prefix + "denied", matrixUserIds);
    await removeDenied(matrixUserIds);
  }
  async function removeDenied(matrixUserIds) {
    for (const matrixUserId of matrixUserIds) {
      if (!(await redis.sIsMember(prefix + "denied", matrixUserId))) continue;
      for (const id of await redis.sMembers(
        prefix + "user:" + key(matrixUserId, ""),
      )) {
        const raw = await redis.hGet(prefix + "participants", id);
        if (!raw) throw new Error("Missing participant mapping");
        if (await redis.sIsMember(prefix + "denied", matrixUserId))
          await remove(JSON.parse(raw));
      }
    }
    await checkUnmapped();
  }
  async function checkUnmapped() {
    let unknown = false;
    for (const room of await rooms.listRooms()) {
      for (const participant of await rooms.listParticipants(room.name)) {
        const id = key(room.name, participant.identity);
        if (await redis.exists(prefix + "forgotten:" + id)) {
          await remove({ room: room.name, identity: participant.identity });
        } else if (!(await redis.hExists(prefix + "participants", id))) {
          unknown = true;
        }
      }
    }
    if (unknown)
      throw Object.assign(new Error("Unmapped active participant"), {
        code: "UNMAPPED_ACTIVE_PARTICIPANT",
      });
  }
  async function forget(matrixUserIds) {
    await revoke(matrixUserIds);
    for (const matrixUserId of matrixUserIds) {
      await redis.eval(
        `local ids=redis.call('SMEMBERS',KEYS[1]);
        for _,id in ipairs(ids) do
          redis.call('SET',ARGV[2]..id,'1','EX',86400,'NX');
          redis.call('HDEL',KEYS[2],id);
        end
        redis.call('DEL',KEYS[1]); redis.call('SREM',KEYS[3],ARGV[1]); return 1`,
        {
          keys: [
            prefix + "user:" + key(matrixUserId, ""),
            prefix + "participants",
            prefix + "denied",
          ],
          arguments: [matrixUserId, prefix + "forgotten:"],
        },
      );
    }
  }
  function authorized(req) {
    const actual = Buffer.from(req.get("authorization") || "");
    const expected = Buffer.from("Bearer " + config.sharedSecret);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  function mount(app) {
    app.post(
      "/internal/lifecycle/webhook",
      express.text({ type: "*/*", limit: "256kb" }),
      async (req, res) => {
        let event;
        try {
          event = await webhook.receive(
            req.body,
            req.get("authorization"),
            false,
            0,
          );
        } catch {
          return res.sendStatus(403);
        }
        if (event.event !== "participant_joined") return res.sendStatus(204);
        const room = event.room?.name,
          identity = event.participant?.identity;
        if (!room || !identity) return res.sendStatus(400);
        try {
          const raw = await redis.hGet(
            prefix + "participants",
            key(room, identity),
          );
          const record = raw ? JSON.parse(raw) : null;
          if (!record) {
            if (
              !(await redis.exists(prefix + "forgotten:" + key(room, identity)))
            )
              return res.sendStatus(503);
            await remove({ room, identity });
            return res.sendStatus(204);
          }
          if (
            (await redis.sIsMember(prefix + "denied", record.matrixUserId)) ||
            !(await active(record.matrixUserId))
          ) {
            await remove({ room, identity });
          }
          return res.sendStatus(204);
        } catch {
          return res.sendStatus(503);
        }
      },
    );
    for (const action of ["revoke", "restore", "forget"])
      app.post(
        "/internal/lifecycle/" + action,
        express.json({ limit: "16kb" }),
        async (req, res) => {
          if (!authorized(req)) return res.sendStatus(403);
          const ids = req.body?.matrixUserIds;
          if (
            !Array.isArray(ids) ||
            ids.length < 1 ||
            ids.length > 100 ||
            ids.some(
              (id) =>
                typeof id !== "string" ||
                !id.startsWith("@") ||
                id.length > 512,
            )
          )
            return res.sendStatus(400);
          try {
            if (action === "revoke") await revoke(ids);
            else if (action === "forget") await forget(ids);
            else await redis.sRem(prefix + "denied", ids);
            return res.sendStatus(204);
          } catch (error) {
            return res.status(503).json({
              error:
                error.code === "UNMAPPED_ACTIVE_PARTICIPANT"
                  ? error.code
                  : "MEDIA_REVOCATION_UNCONFIRMED",
            });
          }
        },
      );
    app.get("/internal/lifecycle/admit", async (req, res) => {
      try {
        const uri = new URL(
          req.get("x-original-uri") || "/",
          "http://internal",
        );
        const queryTokens = uri.searchParams.getAll("access_token");
        const headerToken = req.get("authorization")?.replace(/^Bearer /, "");
        if (
          queryTokens.length > 1 ||
          (queryTokens[0] && headerToken && queryTokens[0] !== headerToken)
        )
          return res.sendStatus(403);
        const jwt = queryTokens[0] || headerToken;
        let c;
        try {
          c = await claims(jwt);
        } catch {
          return res.sendStatus(403);
        }
        const raw = await redis.hGet(
          prefix + "participants",
          key(c.video.room, c.sub),
        );
        if (
          !raw ||
          (await redis.sIsMember(
            prefix + "denied",
            JSON.parse(raw).matrixUserId,
          )) ||
          !(await active(JSON.parse(raw).matrixUserId))
        )
          return res.sendStatus(403);
        return res.sendStatus(204);
      } catch {
        return res.sendStatus(503);
      }
    });
  }
  let stopped = false,
    running = null;
  async function reconcile() {
    try {
      await checkUnmapped();
    } catch {
      /* Keep bounded forgotten tombstones for the next pass. */
    }
    for await (const members of redis.sScanIterator(prefix + "denied", {
      COUNT: 100,
    })) {
      for (const matrixUserId of members) {
        if (stopped) return;
        try {
          await removeDenied([matrixUserId]);
        } catch {
          /* Durable deny survives failures for the next pass. */
        }
      }
    }
  }
  const timer = setInterval(() => {
    if (!stopped && !running)
      running = reconcile()
        .catch(() => {})
        .finally(() => {
          running = null;
        });
  }, config.reconcileIntervalMs || 5000);
  timer.unref();
  return {
    mount,
    registerIssued,
    close: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (running) await running;
      if (redis.isReady) await redis.quit();
      else redis.destroy();
    },
  };
}
async function createLifecycleFromEnvironment() {
  if (process.env.MATRIXRTC_LIFECYCLE_ENABLED !== "true") return null;
  const read = (name) => {
    const path = process.env[name];
    if (!path) throw new Error("Missing lifecycle configuration");
    const value = require("node:fs").readFileSync(path, "utf8").trim();
    if (!value) throw new Error("Empty lifecycle configuration");
    return value;
  };
  const policyUrl = process.env.MATRIXRTC_LIFECYCLE_POLICY_URL;
  const livekitUrl = process.env.MATRIXRTC_LIFECYCLE_LIVEKIT_URL;
  for (const value of [policyUrl, livekitUrl]) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid lifecycle endpoint");
  }
  return createLifecycle({
    redisUrl: read("MATRIXRTC_LIFECYCLE_REDIS_URL_FILE"),
    sharedSecret: read("MATRIXRTC_LIFECYCLE_TOKEN_FILE"),
    apiKey: read("MATRIXRTC_LIFECYCLE_LIVEKIT_KEY_FILE"),
    apiSecret: read("MATRIXRTC_LIFECYCLE_LIVEKIT_SECRET_FILE"),
    policyUrl,
    livekitUrl,
  });
}
module.exports = { createLifecycle, createLifecycleFromEnvironment };
