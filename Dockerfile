FROM node:20-alpine
RUN apk add --no-cache python3 make g++ sqlite
WORKDIR /app
COPY server/package.json ./server/
WORKDIR /app/server
RUN npm install --omit=dev
WORKDIR /app
COPY server ./server
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production
ENV DB_PATH=/data/health.db
ENV PORT=3000
EXPOSE 3000
WORKDIR /app/server
CMD ["node", "server.js"]
