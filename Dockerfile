# --- Base image ---
FROM node:22-alpine AS base
WORKDIR /app

# --- Install all dependencies for the build ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- Build the TypeScript app ---
FROM deps AS build
COPY . .
RUN npm run build

# --- Install production-only dependencies ---
FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Production runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

RUN mkdir -p storage tmp && chown -R node:node /app

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
