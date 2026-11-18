import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Most tests are pure logic and run in plain Node; files that need a DOM opt in with a
  // `// @vitest-environment jsdom` comment, so jsdom is only started where it is used.
  test: { environment: "node", setupFiles: ["./vitest.setup.ts"], exclude: ["e2e/**", "node_modules/**"] },
});
