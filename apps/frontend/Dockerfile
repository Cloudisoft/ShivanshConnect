# Plain Dockerfile build for the frontend, bypassing Railway's Railpack/mise
# toolchain-downloader entirely (it was intermittently failing to fetch its
# own `mise` binary from GitHub - a Railway build-infra issue, unrelated to
# this app). Runs from the monorepo root as build context.

FROM node:20-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Install deps for the whole workspace first (better layer caching).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN pnpm --filter @shivanshconnect/shared run build
RUN pnpm --filter @shivanshconnect/frontend exec tsc --noEmit

# Vite inlines these into the client bundle at build time, so they must be
# real environment variables during `vite build`, not just runtime vars.
# Railway passes each service variable as a same-named build ARG automatically.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @shivanshconnect/frontend exec vite build

FROM node:20-slim AS run
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=build /repo /repo
WORKDIR /repo/apps/frontend
EXPOSE 4173
CMD ["sh", "-c", "pnpm exec vite preview --host 0.0.0.0 --port ${PORT:-4173} --strictPort"]
