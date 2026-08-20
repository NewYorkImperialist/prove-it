# Two stages: the first installs everything and builds the Next.js client bundle, the second
# ships only the build output plus runtime dependencies.
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Cloudflare Analytics token. Next inlines NEXT_PUBLIC_* at build time, so this has to arrive as a
# build arg — a runtime env var would come too late for a prerendered page. Unset is fine and is
# what a fork gets: app/layout.jsx then renders no beacon script at all.
ARG NEXT_PUBLIC_CF_BEACON_TOKEN=""
ENV NEXT_PUBLIC_CF_BEACON_TOKEN=$NEXT_PUBLIC_CF_BEACON_TOKEN
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
# The server half of the app (Express API + Socket.IO + the game engines) runs from source;
# only the client needs building, and .next carries that.
COPY . .
COPY --from=build /app/.next ./.next
EXPOSE 3000
CMD ["node", "server/index.js"]
