FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
COPY scripts/apply-security-migration.mjs ./scripts/
RUN npm run build \
    && mkdir -p dist/ui-resources \
    && cp -R src/ui-resources/templates dist/ui-resources/templates \
    && npm prune --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# The runtime starts Node directly and does not install packages. Remove the
# package-manager toolchains bundled in the base image so their dependency
# trees are not part of the production attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/migrations ./src/migrations
COPY --from=build --chown=node:node /app/scripts/apply-security-migration.mjs ./scripts/apply-security-migration.mjs

# Fail closed if a future base-image change leaves package-manager tooling in
# the final filesystem. Node itself remains the only required global runtime.
RUN test -x /usr/local/bin/node \
    && test ! -e /usr/local/bin/npm \
    && test ! -e /usr/local/bin/npx \
    && test ! -e /usr/local/bin/corepack \
    && test ! -e /usr/local/bin/yarn \
    && test ! -e /usr/local/bin/yarnpkg \
    && test ! -e /usr/local/lib/node_modules/npm \
    && test ! -e /usr/local/lib/node_modules/corepack \
    && test ! -e /opt/yarn-v1.22.22

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/ready', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index-http.js"]
