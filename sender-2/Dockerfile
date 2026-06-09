FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

CMD ["npm", "run", "worker:claim"]
