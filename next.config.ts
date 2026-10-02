import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Geen ESLint in dit MVP; TypeScript-checks blijven wel aan tijdens de build.
  eslint: { ignoreDuringBuilds: true },
  // Bestandsparsers niet bundelen maar uit node_modules laden (betrouwbaarder in serverless).
  serverExternalPackages: ["unpdf", "mammoth", "jszip", "xlsx"],
};

export default nextConfig;
