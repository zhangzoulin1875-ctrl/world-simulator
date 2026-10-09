FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY sql ./sql
COPY map ./map
COPY public ./public
EXPOSE 10000
CMD ["node", "src/index.js"]
