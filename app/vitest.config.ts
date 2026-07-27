import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // settings.ts touches localStorage; jsdom provides it without a browser.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
