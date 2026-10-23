# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build
RUN mkdir -p /shared-storage
EXPOSE 5100
ENV PORT=5100
CMD ["npm", "start"]
