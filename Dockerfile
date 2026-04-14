# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/prisma ./prisma
# the seed script reuses the domain logic (consensus, gold scoring)
COPY --from=build --chown=node:node /app/app/domain ./app/domain
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["entrypoint.sh"]
CMD ["node_modules/.bin/react-router-serve", "./build/server/index.js"]
