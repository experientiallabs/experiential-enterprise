import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    setupFiles: ["./tests/unit/setup.ts"]
  },
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
      // The real marker throws outside a React Server environment by design.
      "server-only": new URL("./tests/unit/stubs/server-only.ts", import.meta.url).pathname
    }
  }
});
