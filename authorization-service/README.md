# ORISO authorization-service image

This image is built from the exact upstream
`element-hq/lk-jwt-service` revision recorded in the Dockerfile. The GitHub
source archive is verified by SHA-256 before compilation.

ORISO replaces only upstream `main.go` and adds one regression test. The
override adds `LIVEKIT_LOG_LEVEL=off`, which discards both structured `slog`
records and standard-library `log` records. This is required because the
pinned upstream revision includes Matrix users, rooms, member structures and
occasionally OpenID data in error-level attributes.

The image build may also raise a vulnerable transitive dependency to an
explicit fixed version while keeping the upstream source revision immutable.
The Dockerfile currently requires `google.golang.org/grpc` 1.82.1 and builds
with Go 1.26.5. Both floors are enforced by a repository test and the final
binary is scanned after compilation.

The Helm chart must run this ORISO image with `LIVEKIT_LOG_LEVEL=off`. Health
and readiness probes remain the operational signal until a privacy-safe metrics
surface is available.

Every upstream revision bump must:

1. update and verify `UPSTREAM_REVISION` and `UPSTREAM_ARCHIVE_SHA256`;
2. compare upstream `main.go` with `overrides/main.go`;
3. rerun the complete upstream Go test suite during the image build; and
4. publish and pin a new immutable multi-architecture image digest.
