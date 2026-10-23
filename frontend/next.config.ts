import path from "path";
import type { NextConfig } from "next";

const rawTarget = process.env.DOCS_API_PROXY_TARGET || "http://localhost:5100";
const API_TARGET = rawTarget.startsWith("http") ? rawTarget : `http://${rawTarget}`;

const nextConfig: NextConfig = {
  // Keep Turbopack scoped to this app (ignore parent package-lock.json)
  turbopack: {
    root: path.join(__dirname),
  },
  // Hide the Next.js "N" logo / static indicator in the corner during `next dev`
  devIndicators: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // Dev rewrites proxy /api → gateway; default ~30s kills long chat/RAG requests (socket hang up)
    proxyTimeout: Number(process.env.DOCS_API_PROXY_TIMEOUT_MS || 300000),
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_TARGET}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
