const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { AccessToken } = require("livekit-server-sdk");

test("real policy gateway registers verified Matrix identity before delivering upstream JWT", async (t) => {
  const secret = "test-secret-at-least-32-characters";
  const token = new AccessToken("test-key", secret, {
    identity: "gateway-alice",
    ttl: "1h",
  });
  token.addGrant({ roomJoin: true, room: "gateway-room" });
  const jwt = await token.toJwt();
  let active = true;
  const remote = createServer((req, res) => {
    if (req.url === "/media-policy") {
      assert.equal(
        req.headers["x-matrixrtc-lifecycle-token"],
        "internal-secret-at-least-32-characters",
      );
      res.writeHead(active ? 204 : 403);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/openid/userinfo"))
      res.end(JSON.stringify({ sub: "@alice:matrix.test" }));
    else if (req.url.includes("/joined_members"))
      res.end(JSON.stringify({ joined: { "@alice:matrix.test": {} } }));
    else if (req.url.includes("join_rules"))
      res.end(
        JSON.stringify({
          join_rule: "restricted",
          allow: [
            { type: "m.room_membership", room_id: "!source:matrix.test" },
          ],
        }),
      );
    else if (req.url === "/call-policy")
      res.end(JSON.stringify({ audioAllowed: true, videoAllowed: true }));
    else if (req.url === "/get_token")
      res.end(JSON.stringify({ url: "wss://sfu.test", jwt }));
    else res.end("{}");
  });
  await new Promise((r) => remote.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${remote.address().port}`;
  const portServer = createServer();
  await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  const dir = mkdtempSync(join(tmpdir(), "livekit-lifecycle-"));
  const file = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      MATRIX_SERVER_NAME: "matrix.test",
      MATRIXRTC_ALLOWED_ORIGINS: "https://call.test",
      MATRIX_FEDERATION_BASE_URL: base,
      MATRIX_CLIENT_BASE_URL: base,
      MATRIX_MEMBERSHIP_TOKEN_FILE: file("membership", "member"),
      MATRIXRTC_CALL_POLICY_TOKEN_FILE: file("call", "call"),
      MATRIXRTC_UPSTREAM_URL: base,
      MATRIXRTC_CALL_POLICY_URL: base + "/call-policy",
      MATRIXRTC_LIFECYCLE_ENABLED: "true",
      MATRIXRTC_LIFECYCLE_TOKEN_FILE: file(
        "internal",
        "internal-secret-at-least-32-characters",
      ),
      MATRIXRTC_LIFECYCLE_REDIS_URL_FILE: file(
        "redis",
        process.env.LIFECYCLE_TEST_REDIS_URL,
      ),
      MATRIXRTC_LIFECYCLE_LIVEKIT_KEY_FILE: file("key", "test-key"),
      MATRIXRTC_LIFECYCLE_LIVEKIT_SECRET_FILE: file("secret", secret),
      MATRIXRTC_LIFECYCLE_POLICY_URL: base + "/media-policy",
      MATRIXRTC_LIFECYCLE_LIVEKIT_URL: base,
    },
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => remote.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 30));
  }
  const issue = () =>
    fetch(url + "/livekit/jwt/get_token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://call.test",
      },
      body: JSON.stringify({
        room_id: "!room:matrix.test",
        slot_id: "slot",
        openid_token: {
          access_token: "test-openid",
          matrix_server_name: "matrix.test",
        },
        member: {
          claimed_user_id: "@alice:matrix.test",
          claimed_device_id: "device",
          id: "member",
        },
      }),
    });
  const response = await issue();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).jwt, jwt);
  assert.equal(
    (
      await fetch(url + "/internal/lifecycle/admit", {
        headers: { "x-original-uri": "/rtc?access_token=" + jwt },
      })
    ).status,
    204,
  );
  active = false;
  assert.equal((await issue()).status, 503);
  assert.equal(
    (
      await fetch(url + "/internal/lifecycle/admit", {
        headers: { "x-original-uri": "/rtc?access_token=" + jwt },
      })
    ).status,
    403,
  );
});
