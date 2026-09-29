FROM node:24.14.0-bookworm-slim AS workspace
RUN npm install --global pnpm@11.15.1
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/api-node/package.json apps/api-node/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY docker/api-runtime/package.json docker/api-runtime/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api-node apps/api-node
COPY packages/backend packages/backend
COPY packages/contracts packages/contracts
COPY packages/database packages/database
COPY docker/certs docker/certs
COPY scripts/build-api-runtime.ts scripts/build-api-runtime.ts
RUN cd /workspace/docker/certs \
  && sha256sum --check global-bundle.pem.sha256
RUN pnpm exec tsc -b --force apps/api-node && node scripts/build-api-runtime.ts
RUN pnpm --filter @starter/api-runtime-dependencies deploy --prod --legacy /runtime

FROM node:24.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV MIGRATIONS_DIRECTORY=/app/migrations
WORKDIR /app
COPY --from=workspace /runtime/package.json /app/package.json
COPY --from=workspace /runtime/node_modules /app/node_modules
COPY --from=workspace /workspace/apps/api-node/dist/runtime/api.mjs /app/api.mjs
COPY --from=workspace /workspace/apps/api-node/dist/runtime/migrate.mjs /app/migrate.mjs
COPY --from=workspace /workspace/packages/database/migrations /app/migrations
COPY --from=workspace /workspace/docker/certs/global-bundle.pem /app/certs/global-bundle.pem
RUN chmod 0444 /app/certs/global-bundle.pem
USER node
CMD ["node", "/app/api.mjs"]
