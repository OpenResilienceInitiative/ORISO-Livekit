ARG UPSTREAM_REVISION=a375b130a43fade115e0e71ad159f11265107d89
ARG UPSTREAM_ARCHIVE_SHA256=72f36f4411a2ac0412aa549eb421abde25e4ad770be7834385b20a57f0954967

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS source
ARG UPSTREAM_REVISION
ARG UPSTREAM_ARCHIVE_SHA256
WORKDIR /download
RUN wget -qO source.tar.gz "https://github.com/element-hq/lk-jwt-service/archive/${UPSTREAM_REVISION}.tar.gz" \
    && echo "${UPSTREAM_ARCHIVE_SHA256}  source.tar.gz" | sha256sum -c - \
    && mkdir /src \
    && tar -xzf source.tar.gz --strip-components=1 -C /src

# Go 1.26.10 clears the stdlib findings the image gate rejects. 1.26.9 was
# rejected for CVE-2026-111943 (crypto/x509), fixed in 1.26.10; 1.26.6 before
# it for CVE-2026-78667, CVE-2026-78669 and CVE-2026-97031. The toolchain version is what Trivy reports as `stdlib`, so it moves
# with the builder image.
FROM --platform=${BUILDPLATFORM} golang:1.26.10-alpine@sha256:5cb67f19c5e7994dcb80c074f7cfca8aeeada45bbdca035f73df269cefdcce61 AS builder
RUN apk add --no-cache patch
WORKDIR /src
COPY --from=source /src /src
COPY overrides/call_policy.patch /tmp/call_policy.patch
RUN patch -p1 < /tmp/call_policy.patch
COPY overrides/main.go ./main.go
COPY overrides/call_policy_test.go ./call_policy_test.go
COPY overrides/logging_test.go ./logging_test.go
COPY overrides/federation_url_override.go ./federation_url_override.go
COPY overrides/federation_url_override_test.go ./federation_url_override_test.go
# Overrides for findings the image vulnerability gate rejects:
#   grpc      1.83.2 — CVE-2026-84304 and CVE-2026-84445 (DoS via malformed RPC
#                      requests). 1.83.1 fixes only the first of the two.
#   x/crypto  0.55.0 — CVE-2026-56854, SSH authentication bypass through
#                      unenforced source-address restrictions.
#   x/net     0.60.0 — CVE-2026-78669, HTTP/2 SETTINGS flood DoS. The Go 1.26.9
#                      toolchain fixes the stdlib copy; the module copy needs
#                      its own floor.
#   compress  1.18.7 — CVE-2026-63209, arrives transitively through the gRPC
#                      and Matrix client stacks.
#   x/text    0.39.0 — pre-existing override, unchanged.
RUN go mod edit -require=google.golang.org/grpc@v1.83.2 \
    && go mod edit -require=golang.org/x/crypto@v0.55.0 \
    && go mod edit -require=golang.org/x/net@v0.60.0 \
    && go mod edit -require=github.com/klauspost/compress@v1.18.7 \
    && go mod edit -require=golang.org/x/text@v0.39.0 \
    && go mod tidy \
    && go test ./...

ARG TARGETOS TARGETARCH
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -o /out/lk-jwt-service .
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -o /out/lk-jwt-service-healthcheck ./healthcheck
RUN echo 'hosts: files dns' > /out/nsswitch.conf

FROM scratch
ARG UPSTREAM_REVISION
LABEL org.opencontainers.image.source="https://github.com/OpenResilienceInitiative/ORISO-Livekit" \
      org.opencontainers.image.description="Element MatrixRTC authorization service with ORISO no-identifiers logging mode" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.upstream-revision="${UPSTREAM_REVISION}"
COPY --from=builder /out/lk-jwt-service /lk-jwt-service
COPY --from=builder /out/lk-jwt-service-healthcheck /lk-jwt-service-healthcheck
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/nsswitch.conf /etc/nsswitch.conf
USER 65532:65532
EXPOSE 8080
CMD ["/lk-jwt-service"]
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["/lk-jwt-service-healthcheck"]
