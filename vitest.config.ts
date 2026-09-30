import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// Laadt .env / .env.local (lokaal) of de omgevingsvariabelen van CI.
// Live-tests tegen het echte model draaien alleen als GONKA_API_KEY gezet is.
export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    env: loadEnv(mode, process.cwd(), ""),
  },
}));
