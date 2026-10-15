import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server forwards /api to the gateway, so the browser talks to one
// origin and no CORS configuration is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080" },
  },
});
