# Plain Dockerfile build for the backend, matching apps/frontend/Dockerfile's
# approach (bypasses Railway's intermittently-flaky Railpack/mise downloader)
# and giving us a real `psql` client for running database migrations as a
# Railway preDeployCommand (apps/backend/scripts/migrate.sh) - this sandbox
# has no direct network access to Postgres, but the deployed Railway service
# does, so it applies the schema itself on each deploy.

FROM node:20-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @shivanshconnect/shared run build
RUN pnpm --filter @shivanshconnect/backend run build

FROM node:20-slim AS run
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=build /repo /repo
COPY supabase/migrations /repo/supabase/migrations
RUN chmod +x /repo/apps/backend/scripts/migrate.sh
WORKDIR /repo
EXPOSE 4000
CMD ["node", "apps/backend/dist/index.js"]
