import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // settings.ts touches localStorage; jsdom provides it without a browser.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    // V05-W3 (D-067): the recording-time ladder deliberately reads a BWF's date + clock and
    // a timestamp in a filename as LOCAL wall time, and a container stamp as UTC. That
    // distinction is only testable against a KNOWN offset — on a machine set to UTC the two
    // doors are indistinguishable and the tests would pass while the app was two hours
    // wrong for its actual users. Europe/Oslo is where the owner's cameras were.
    env: { TZ: "Europe/Oslo" },
  },
});
