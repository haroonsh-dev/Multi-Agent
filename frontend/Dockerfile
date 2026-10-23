# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app

# Browser API base. Kept as the host-agnostic same-origin "/api" so the built
# bundle works from any hostname (LAN IP, localhost, …); Next.js rewrites
# /api/* to DOCS_API_PROXY_TARGET at runtime (see next.config.ts).
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG DOCS_API_PROXY_TARGET=http://localhost:5100
ENV DOCS_API_PROXY_TARGET=${DOCS_API_PROXY_TARGET}

COPY package*.json ./
# Cache mount so a retry on the flaky uplink resumes from downloaded tarballs.
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build
EXPOSE 3124
ENV PORT=3124
CMD ["npm", "run", "start", "--", "-p", "3124"]
