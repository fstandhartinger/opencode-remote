FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080

RUN addgroup -S app && adduser -S -G app app \
    && mkdir -p /app/public \
    && chown -R app:app /app

USER app

EXPOSE 8080

CMD ["node", "server.js"]