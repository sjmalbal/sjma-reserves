FROM node:22-bookworm-slim AS build
WORKDIR /app/reservas-ts
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
COPY assets ./assets
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/reservas-ts
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/reservas-ts/dist ./dist
COPY --from=build /app/reservas-ts/public ./public
COPY --from=build /app/reservas-ts/assets ./assets
USER node
EXPOSE 8766
CMD ["node", "dist/server.js"]
