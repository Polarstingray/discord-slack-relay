FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js channels.json ./

USER node
CMD ["node", "index.js"]
