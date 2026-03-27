FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY scripts/local-backend.js /app/scripts/local-backend.js

EXPOSE 3000

RUN mkdir -p /data && chown -R node:node /data
USER node

CMD ["node", "/app/scripts/local-backend.js"]
