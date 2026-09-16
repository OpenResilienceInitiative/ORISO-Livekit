# Account lifecycle enforcement for MatrixRTC

This is the LiveKit part of UserService inactivity requirement R7. It is disabled
unless `MATRIXRTC_LIFECYCLE_ENABLED=true`. It requires the coordinated UserService
media policy/effects and Helm signaling isolation changes. This module does not
make self-hosted LiveKit tokens intrinsically revocable.

## Contract

The existing `matrixrtc-auth-policy-gateway:3010` owns these internal routes:

| Route | Authentication | Result |
| --- | --- | --- |
| `GET /internal/lifecycle/admit` | Cryptographically verified participant JWT from `X-Original-URI` query `access_token`, or `Authorization: Bearer <participant JWT>` | 204 only for a known `(room, subject)` and currently ACTIVE Matrix identity; 403 denied; 503 unavailable |
| `POST /internal/lifecycle/revoke` | Dedicated shared `Authorization: Bearer` secret | Body `{ "matrixUserIds": ["@person:homeserver"] }`; 204 only after SFU absence is verified; 503 remains retryable |
| `POST /internal/lifecycle/forget` | Same dedicated shared secret | Same body; after successful account deletion, confirms removal then erases personal mappings; 204 success, 503 retry |
| `POST /internal/lifecycle/restore` | Same dedicated shared secret | Same body; clears local denial, 204; current UserService policy still controls admission |
| `POST /internal/lifecycle/webhook` | Official LiveKit signed webhook with raw-body digest verification | Handles participant joins, departures and room completion; removes mapped denied/nonactive participants, 503 on unconfirmed effects or unknown mappings |

The outbound policy is `POST /internal/matrixrtc/media-access` on UserService,
with `x-matrixrtc-lifecycle-token` and `{ "matrixUserId": "@person:homeserver" }`.
Only HTTP 204 means ACTIVE. HTTP 403 means blocked or uncertain; HTTP 410 means
the authenticated authority has confirmed the identity binding is gone or its
policy is terminal DELETED. Both deny admission. Every other result fails closed.
No policy lookup uses a user-supplied destination.

Required enabled-mode configuration:

- `MATRIXRTC_LIFECYCLE_TOKEN_FILE`: dedicated shared lifecycle secret (minimum 32 characters), separate from LiveKit's signing key.
- `MATRIXRTC_LIFECYCLE_REDIS_URL_FILE`: authenticated Redis connection URL.
- `MATRIXRTC_LIFECYCLE_LIVEKIT_KEY_FILE` and `MATRIXRTC_LIFECYCLE_LIVEKIT_SECRET_FILE`: existing LiveKit API credentials.
- `MATRIXRTC_LIFECYCLE_LIVEKIT_URL`: private RoomService base, normally `http://livekit:7880`.
- `MATRIXRTC_LIFECYCLE_POLICY_URL`: private UserService policy URL above.

Secrets are read from mounted files. They, participant JWTs and raw webhook
bodies are not logged or stored. Redis stores Matrix IDs and opaque participant
identities; restrict access and use persistent storage with no eviction for this
namespace. Active participants retain their mappings even after their original
JWT expiry because LiveKit refreshes connected clients' tokens. A verified signed
`participant_left` or `room_finished` event schedules cleanup only after an SFU
`GetParticipant` lookup confirms absence. The bounded periodic registry scan also
observes absence, so a lost departure webhook cannot retain a historical mapping
forever. Cleanup becomes eligible at the later of the greatest verified issued
JWT expiry and 24 hours after confirmed absence. It rechecks actual absence before
erasing the entry; transport failures retain it. New registration or a signed
join cancels the deadline and changes the record version, fencing cleanup already
in flight. Unknown legacy records without a verified expiry are retained until
reissued or confirmed account deletion. Cleanup retains only the same bounded
hashed late-arrival marker described below; an old unregistered JWT must obtain
fresh authorized issuance to rejoin. After successful account deletion, UserService must
call `forget`: raw Matrix ID, room/subject mappings, user index and denial entries
are removed atomically per identity. Only SHA-256(room, subject) security markers
remain for 24 hours, with no raw identifiers; retries do not extend their TTL.
Signed webhooks and periodic actual-participant inventory remove late arrivals
matching these markers even if a webhook was lost. Unknown old JWTs remain
inadmissible after the markers expire because they have no registry entry.
All in-flight signaling timeouts must be below 24 hours (Helm uses 3600 seconds).
Manual deletion paths are covered by periodic registry garbage collection:
every minute, at most 100 registry entries are checked against the authenticated
policy. HSCAN overflow entries are carried into later batches. Only confirmed
410 triggers immediate removal of that known subject and personal mapping cleanup.
Other definitive policy responses use the confirmed-departure retention rules above;
authority outages and incomplete remote removal retain mappings for retry.
This worker runs independently from five-second revocation reconciliation.
Unlike explicit lifecycle completion, GC may erase an already-deleted subject's
verified-absent mappings even while unrelated unknown participants exist; it
never disconnects those unrelated participants or declares core work complete.
Do not clear this namespace during active calls.

## Ordering and retry semantics

The policy gateway verifies Matrix OpenID identity and existing room/call policy,
then verifies the upstream-issued JWT and atomically registers its room and
subject before returning it. Registration refuses identities with a durable deny
tombstone and refuses cross-identity mapping replacement. No raw JWT is stored;
refreshed tokens with the same room/subject remain subject to current policy.

Revocation writes denial before remote effects, removes the named identities
and confirms absence with `GetParticipant`, then inventories actual SFU room
participants to detect missing mappings. A missing mapping produces
`503 {"error":"UNMAPPED_ACTIVE_PARTICIPANT"}` without disconnecting unrelated
people. Other unconfirmed remote effects return `MEDIA_REVOCATION_UNCONFIRMED`.
UserService must retain pending lifecycle work on either response.

The gateway continuously reconciles denied identities every five seconds, with
one SFU room inventory per pass regardless of the number of denied identities. Signed
join webhooks handle joins that were in flight during revocation. A restart
reloads the durable denial set. This is a retryable network workflow, not an
atomic transaction across UserService, Redis and LiveKit. A 204 confirms observed
absence at that point; admission fencing plus continuous reconciliation remains
necessary afterward. Restore clears denial while UserService may still be
REACTIVATING; admission remains closed until its policy returns ACTIVE. A
concurrent in-flight removal may finish once, but reconciliation never recreates
a cleared denial tombstone.

## Coordinated activation and rollback

1. Keep lifecycle flags off while deploying compatible gateway, UserService and
   Helm images/configuration. Provision persistent Redis and dedicated secrets.
2. Arrange an explicit maintenance drain/rejoin of preexisting calls before
   enforcement. Do not silently disconnect unrelated existing participants.
   Unregistered pre-rollout JWTs fail closed and existing unmapped participants
   prevent revocation completion. Registry loss is an incident, not evidence that
   no active session exists.
3. Route **every** SFU signaling join/reconnect through the admission subrequest;
   preserve the original URI and disable request/access logs containing JWT query
   strings. Do not publish the internal revocation/restore routes.
4. Isolate SFU signaling port 7880 behind ClusterIP and NetworkPolicy. The old
   hostNetwork/0.0.0.0:7880 layout is not acceptable: external callers could bypass
   ingress. The coordinated Helm path uses pod networking and exposes only the
   required RTC media host ports. Verify external node-IP:7880 is unreachable.
5. Configure LiveKit's signed webhook URL
   `http://matrixrtc-auth-policy-gateway:3010/internal/lifecycle/webhook` in its
   separately provisioned runtime config. Retain the existing upstream webhook.
6. Verify actual media: establish a call, suspend that account, observe media
   disconnect, then retry original and server-refreshed JWTs. Both must fail while
   nonactive. Exercise a simultaneous join, a RoomService outage/retry, gateway
   restart, and authorized reactivation. Unknown mappings must keep work pending.
7. Roll back only as a coordinated operation with inactivity execution stopped;
   restoring a bypassable SFU route alone removes the enforcement boundary.

## Local proof

Run a disposable real Redis, set `LIFECYCLE_TEST_REDIS_URL`, then run `npm test`
under Node 22. CI starts and removes a digest-pinned Redis container itself.
Tests use real Redis and public HTTP boundaries; Matrix, UserService and LiveKit
RoomService are outbound HTTP fixtures. The actual gateway process is tested for
token delivery ordering. This proves local integration behavior, not deployed
WebRTC termination, firewall reachability or production Redis durability.
