FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8777
ENV HOST=0.0.0.0
EXPOSE 8777
VOLUME ["/app/data"]
CMD ["node", "server.js"]
