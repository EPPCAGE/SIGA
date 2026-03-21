FROM node:20-alpine

WORKDIR /app
COPY scripts/local-backend.js /app/local-backend.js

EXPOSE 3000

USER node

CMD ["node", "/app/local-backend.js"]
