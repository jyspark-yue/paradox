import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev/preview the client calls /api/* and Vite forwards it to the FastAPI backend,
// so CORS and the dev-server port don't matter. Set VITE_API_URL to call the backend directly.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.PARADOX_API_TARGET || "http://localhost:8000";
  const proxy = {
    "/api": {
      target,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api/, ""),
    },
  };
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: {
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          manualChunks: { graph: ["cytoscape", "cytoscape-fcose"], react: ["react", "react-dom"] },
        },
      },
    },
  };
});
