FROM node:20-alpine

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY scripts/local-backend.js /app/scripts/local-backend.js

EXPOSE 3000

USER node

CMD ["node", "/app/scripts/local-backend.js"]
