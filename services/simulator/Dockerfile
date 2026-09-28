# syntax=docker/dockerfile:1
# Build context: repository root.   docker build -f services/simulator/Dockerfile .
# Debian (glibc) rather than Alpine: the Kafka client ships prebuilt librdkafka binaries for glibc.

FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/common/package.json packages/common/
COPY services/simulator/package.json services/simulator/
RUN npm ci --no-audit --no-fund
COPY packages/domain packages/domain
COPY packages/common packages/common
COPY services/simulator services/simulator
RUN npx tsc -b services/simulator \
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
COPY --from=build --chown=node:node /app/services/simulator/package.json services/simulator/
COPY --from=build --chown=node:node /app/services/simulator/dist services/simulator/dist
COPY --from=build --chown=node:node /app/services/simulator/config services/simulator/config
RUN mkdir -p /app/data/sim-private && chown -R node:node /app/data
USER node
EXPOSE 9464
CMD ["node", "services/simulator/dist/main.js"]
