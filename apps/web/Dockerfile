# syntax=docker/dockerfile:1
# Build context: repository root.   docker build -f apps/web/Dockerfile .
FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/common/package.json packages/common/
COPY services/simulator/package.json services/simulator/
COPY services/normaliser/package.json services/normaliser/
COPY services/state-processor/package.json services/state-processor/
COPY services/campaign-engine/package.json services/campaign-engine/
COPY services/workshop/package.json services/workshop/
COPY services/auth/package.json services/auth/
COPY services/api/package.json services/api/
COPY services/agent/package.json services/agent/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps/web apps/web
ARG VITE_OIDC_ISSUER=http://localhost:3200
ENV VITE_OIDC_ISSUER=$VITE_OIDC_ISSUER
RUN npm run build -w @cw/web

# Unprivileged nginx (runs as uid 101; pid and temp files under /tmp), so the container never runs as root.
FROM nginxinc/nginx-unprivileged:1.27.3-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 3000
USER 101
