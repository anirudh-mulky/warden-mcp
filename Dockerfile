# Warden in one image: the gateway, which also serves the built dashboard.
#
#   docker compose --profile app up --build
#
# Two stages: "build" installs everything and compiles; the final image
# keeps only what running needs, so it is smaller and has no compilers.

FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.3.4

# Manifests first, so Docker can reuse the (slow) install layer whenever
# only source files change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @warden/dashboard build \
 && pnpm --filter @warden/gateway build \
 && pnpm --filter @warden/gateway deploy --prod --legacy /out \
 && cp -r apps/gateway/dist /out/dist \
 && cp -r apps/dashboard/dist /out/public

FROM node:22-slim
WORKDIR /app
COPY --from=build /out ./
# Owned by the unprivileged user, so the fs upstream can write inside it.
COPY --chown=node:node sandbox ./sandbox

ENV NODE_ENV=production \
    PORT=8080 \
    DASHBOARD_DIR=/app/public \
    FS_SANDBOX_DIR=/app/sandbox

# Never run as root inside the container.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
