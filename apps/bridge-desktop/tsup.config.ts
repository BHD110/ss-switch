import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", preload: "src/preload.ts" },
  format: ["cjs"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  noExternal: [/^@bridge\//],
  external: ["electron"],
  outExtension: () => ({ js: ".cjs" }),
});