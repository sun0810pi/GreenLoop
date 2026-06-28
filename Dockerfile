FROM node:22-alpine

WORKDIR /app

COPY greenloop-backend/package*.json ./greenloop-backend/
RUN cd greenloop-backend && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/greenloop.db.json

RUN mkdir -p /data

EXPOSE 3000

WORKDIR /app/greenloop-backend
CMD ["npm", "start"]
