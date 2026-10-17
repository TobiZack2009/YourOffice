// @ts-check
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Vitest picks up the `test` field from the same config.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2022"
  },
  test: {
    include: ["src/**/*.test.js", "tests/**/*.test.js"],
    environment: "jsdom"
  }
});
