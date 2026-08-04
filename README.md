# ORISO MatrixRTC authorization policy gateway

This repository contains the narrow ORISO policy layer in front of the
upstream Element MatrixRTC authorization service. It does not create LiveKit
JWTs and it does not hold LiveKit API credentials.

The gateway:

- accepts requests only from explicitly configured first-party Element Call
  origins;
- validates the Matrix OpenID token with the configured homeserver;
- derives the Matrix user ID from that validated token;
- allows only rooms on the configured Matrix homeserver;
- verifies that the user is currently joined to the requested room through
  Synapse's authenticated room-members endpoint;
- derives the ORISO source conversation from the call room's restricted join
  rule and asks UserService to verify both current source-room membership and
  the current tenant call policy; and
- limits the signed LiveKit grant to microphone-only or microphone plus video
  sources according to that policy; and
- forwards approved requests to the internal upstream authorization service.

The upstream service and its signed LiveKit webhook remain cluster-internal.
Only this gateway is exposed at the public MatrixRTC authorization URL.
`authorization-service/` builds the exact reviewed upstream revision with the
small ORISO `LIVEKIT_LOG_LEVEL=off` override required to prevent identifiers
and OpenID material from entering container logs.

## Routes

The public base URL is `/livekit/jwt`.

| Public route | Internal upstream route |
| --- | --- |
| `POST /livekit/jwt/sfu/get` | `POST /sfu/get` |
| `POST /livekit/jwt/get_token` | `POST /get_token` |
| `POST /livekit/jwt/delegate_delayed_leave` | `POST /delegate_delayed_leave` |

`GET /health` is the unauthenticated health probe. The former
`GET /api/livekit/token` and custom JWT issuer are intentionally absent.

## Required configuration

| Environment variable | Purpose |
| --- | --- |
| `MATRIXRTC_ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins |
| `MATRIX_SERVER_NAME` | Exact local Matrix server name |
| `MATRIX_FEDERATION_BASE_URL` | Internal or trusted homeserver base URL used for OpenID validation |
| `MATRIX_CLIENT_BASE_URL` | Trusted HTTPS homeserver client API used for `joined_members` checks |
| `MATRIX_MEMBERSHIP_TOKEN_FILE` | Mounted file containing the dedicated non-admin membership-reader token |
| `MATRIXRTC_UPSTREAM_URL` | Cluster-internal upstream authorization-service URL |
| `MATRIXRTC_CALL_POLICY_URL` | Cluster-internal UserService call-policy endpoint |
| `MATRIXRTC_CALL_POLICY_TOKEN_FILE` | Mounted file containing the shared call-policy authentication token |

Optional limits are `PORT`, `MATRIXRTC_REQUEST_TIMEOUT_MS`,
`MATRIXRTC_MAX_AUTHORITY_RESPONSE_BYTES`,
`MATRIXRTC_RATE_LIMIT_WINDOW_MS`, and
`MATRIXRTC_RATE_LIMIT_MAX_REQUESTS`. JSON request bodies are limited to 16 KiB,
authority responses default to 256 KiB, and the complete OpenID → membership →
JWT chain has one shared deadline. The gateway has an in-process rate-limit as
a fail-safe; ingress limiting remains the first line of defence because it sees
the authoritative client address.

The membership-reader credential must not be a Synapse server-admin token. Use
a dedicated service identity that ORISO Frontend invites to each newly created
call room. The gateway accepts that invitation immediately before reading
`joined_members`, so the credential cannot inspect rooms it was not invited to.
Mount it from a Kubernetes Secret; never place it in a ConfigMap, image,
repository, log, URL, or client response. Kicked, left, invited, and banned
users are absent from `joined_members` and therefore cannot receive media
credentials.

The call-policy credential is shared only by this gateway and UserService.
Policy lookup is fail-closed: an unknown source room, missing tenant settings,
disabled call media, malformed response, or unavailable UserService prevents a
new media credential from being issued. Existing browser tabs therefore pick
up an Admin Off/On change on their next call, reconnect, or rejoin without
requiring a page reload.

## Local validation

```sh
cd token-service
npm ci
npm test
docker build -t matrixrtc-auth-policy-gateway:test .
```

The test suite uses only local fake Synapse and upstream servers. No ORISO
account, room ID, token, or infrastructure secret is required.

## Deployment gates

- Deploy a reviewed, immutable multi-architecture digest of the ORISO
  authorization-service image built from the pinned upstream revision.
- Configure LiveKit with `room.auto_create: false`.
- Keep the upstream authorization service and its signed SFU webhook private.
- Store every credential in Kubernetes Secrets and rotate all historical
  credentials that were previously committed to this repository.
- Pin the gateway, upstream authorization service, and LiveKit images by
  immutable digest.
- Run negative authorization tests and a two-browser MatrixRTC call on PreDev
  before enabling Element Call widget mode by default.
