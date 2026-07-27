FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

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

USER node

EXPOSE 3010

CMD ["node", "server.js"]
