import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The agent API (treasury HTTP server + read-only web routes) binds to
// 127.0.0.1:8378. Both `vite dev` and `vite preview` proxy /v1 there, so the
// frontend never needs CORS. Override with WEB_API_PROXY for a remote agent.
const API_TARGET = process.env.WEB_API_PROXY ?? "http://127.0.0.1:8378";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/v1": { target: API_TARGET, changeOrigin: true },
    },
  },
});
