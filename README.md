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
  Synapse's authenticated room-members endpoint; and
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
| `MATRIX_ADMIN_BASE_URL` | Internal Synapse base URL used for room membership checks |
| `MATRIX_ADMIN_TOKEN_FILE` | Mounted file containing a narrowly managed Synapse admin token |
| `MATRIXRTC_UPSTREAM_URL` | Cluster-internal upstream authorization-service URL |

Optional limits are `PORT` and `MATRIXRTC_UPSTREAM_TIMEOUT_MS`. JSON request
bodies are limited to 16 KiB. Per-client request limiting is enforced at the
ingress, where the original client address is authoritative.

The admin token must be mounted from a Kubernetes Secret. It must never be
placed in a ConfigMap, image, repository, log, URL, or client response.

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
