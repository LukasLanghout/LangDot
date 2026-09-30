import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Geen ESLint in dit MVP; TypeScript-checks blijven wel aan tijdens de build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
