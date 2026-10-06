import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Tack",
        short_name: "Tack",
        theme_color: "#25766b",
        background_color: "#ffffff",
        display: "standalone",
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.TACK_API_ORIGIN || "http://127.0.0.1:3001", ws: true } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: process.env.TACK_API_ORIGIN || "http://127.0.0.1:3001", ws: true } },
  },
});
