import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "../../apps/bridge-desktop/dist/web", emptyOutDir: true, target: "chrome130" },
  server: { port: 5173, strictPort: true },
});
