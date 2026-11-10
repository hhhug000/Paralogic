import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Three.js is most of the bundle and changes rarely, so it gets its
        // own long-lived chunk.
        manualChunks: { three: ["three"] },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
