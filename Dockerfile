# Two stages: the first installs everything and builds the Next.js client bundle, the second
# ships only the build output plus runtime dependencies.
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
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
