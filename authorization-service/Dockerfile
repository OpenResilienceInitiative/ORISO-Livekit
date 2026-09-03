ARG UPSTREAM_REVISION=a375b130a43fade115e0e71ad159f11265107d89
ARG UPSTREAM_ARCHIVE_SHA256=72f36f4411a2ac0412aa549eb421abde25e4ad770be7834385b20a57f0954967

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS source
ARG UPSTREAM_REVISION
ARG UPSTREAM_ARCHIVE_SHA256
WORKDIR /download
RUN apk upgrade --no-cache libssl3 libcrypto3 \
    && wget -qO source.tar.gz "https://github.com/element-hq/lk-jwt-service/archive/${UPSTREAM_REVISION}.tar.gz" \
    && echo "${UPSTREAM_ARCHIVE_SHA256}  source.tar.gz" | sha256sum -c - \
    && mkdir /src \
    && tar -xzf source.tar.gz --strip-components=1 -C /src

FROM --platform=${BUILDPLATFORM} golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS builder
RUN apk upgrade --no-cache libssl3 libcrypto3 \
    && apk add --no-cache patch
WORKDIR /src
COPY --from=source /src /src
COPY overrides/call_policy.patch /tmp/call_policy.patch
RUN patch -p1 < /tmp/call_policy.patch
COPY overrides/main.go ./main.go
COPY overrides/call_policy_test.go ./call_policy_test.go
COPY overrides/logging_test.go ./logging_test.go
COPY overrides/federation_url_override.go ./federation_url_override.go
COPY overrides/federation_url_override_test.go ./federation_url_override_test.go
RUN go mod edit -require=google.golang.org/grpc@v1.82.1 \
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
