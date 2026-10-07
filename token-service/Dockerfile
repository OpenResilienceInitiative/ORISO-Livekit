FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

# CVE-2026-14456: the pinned base is Alpine 3.24.1 and still carries
# libssl3/libcrypto3 3.5.7-r0, while Alpine 3.24 ships the fixed 3.5.8-r0.
# The image vulnerability gate rejects it, which is what has been failing
# "CI - Main" on this image since 2026-08-27. Upgrading the two packages here
# rather than moving the digest pin keeps the fix independent of when the
# upstream node tag is rebuilt; ORISO-Frontend's Dockerfile.storybook does the
# same for the same CVE.
RUN apk upgrade --no-cache libssl3 libcrypto3

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    # npm is a build-time tool only; its bundled dependencies (tar, sigstore,
    # brace-expansion, picomatch, ...) carry fixable CVEs flagged by the image
    # vulnerability gate. The runtime is plain `node server.js`, so drop npm
    # (and corepack) from the shipped image entirely.
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm \
              /usr/local/bin/npx \
              /usr/local/bin/corepack

COPY server.js ./

USER 1000:1000

EXPOSE 3010

CMD ["node", "server.js"]
