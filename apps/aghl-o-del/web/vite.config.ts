import { defineConfig } from "vite";

const BACKEND = process.env.BACKEND_URL || "http://127.0.0.1:8788";

const proxy = {
  "/api": { target: BACKEND, changeOrigin: true },
  "/model": { target: BACKEND, changeOrigin: true },
  "/ws": { target: BACKEND.replace(/^http/, "ws"), ws: true },
};

export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: { exclude: ["phonon-tts"] },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy,
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy,
  },
});
