# build the app, then serve it with the tiny zero-dependency server
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DARKSHED_PORT=8080 DARKSHED_DATA=/data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/merge.js ./src/merge.js
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.mjs"]
