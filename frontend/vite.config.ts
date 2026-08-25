import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/agents": { target: "http://localhost:8787", ws: true },
      "/healthz": "http://localhost:8787",
      "/audit": "http://localhost:8787",
    },
  },
});
