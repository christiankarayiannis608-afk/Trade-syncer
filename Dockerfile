FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
