# Dockerfile for velvetAI API Service
FROM node:24-alpine AS builder

WORKDIR /app
RUN npm install -g pnpm@12.14.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @velvetai/contracts... build && pnpm --filter @velvetai/db build && pnpm --filter @velvetai/worker build && pnpm --filter @velvetai/api build

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN npm install -g pnpm@12.14.0
COPY --from=builder /app ./

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["pnpm", "--filter", "@velvetai/api", "start"]
