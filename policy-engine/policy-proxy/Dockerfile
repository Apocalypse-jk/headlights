FROM node:22-alpine AS build

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
RUN mkdir -p /audit && chown node:node /audit
USER node
EXPOSE 4002
CMD ["node", "dist/server.js"]
