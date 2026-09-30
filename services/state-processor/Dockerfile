# syntax=docker/dockerfile:1
# Build context: repository root.   docker build -f services/state-processor/Dockerfile .
# Debian (glibc) rather than Alpine: the Kafka client ships prebuilt librdkafka binaries for glibc.

FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/common/package.json packages/common/
COPY services/simulator/package.json services/simulator/
COPY services/normaliser/package.json services/normaliser/
COPY services/state-processor/package.json services/state-processor/
COPY services/campaign-engine/package.json services/campaign-engine/
COPY services/workshop/package.json services/workshop/
RUN npm ci --no-audit --no-fund
COPY packages/domain packages/domain
COPY packages/common packages/common
COPY services/state-processor services/state-processor
RUN npx tsc -b services/state-processor \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/domain/package.json packages/domain/
COPY --from=build --chown=node:node /app/packages/domain/dist packages/domain/dist
COPY --from=build --chown=node:node /app/packages/common/package.json packages/common/
COPY --from=build --chown=node:node /app/packages/common/dist packages/common/dist
COPY --from=build --chown=node:node /app/services/state-processor/package.json services/state-processor/
COPY --from=build --chown=node:node /app/services/state-processor/dist services/state-processor/dist
# No data/sim-private here: detection services never see ground truth (CLAUDE.md "No leaks").
USER node
EXPOSE 9466
CMD ["node", "services/state-processor/dist/main.js"]
