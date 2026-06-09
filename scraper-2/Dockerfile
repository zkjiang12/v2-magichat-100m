FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p data/evaluations && chown -R node:node /app

USER node

CMD ["npm", "run", "worker:claim"]
