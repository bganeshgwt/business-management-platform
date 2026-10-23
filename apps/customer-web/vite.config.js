import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const inRepo = (path) => fileURLToPath(new URL(path, import.meta.url));

// The guests' site. Its own port in development (the staff app is on 5173).
// Its built files go under guest-assets/ rather than assets/, so one domain
// can serve both apps' builds side by side (docs/GO_LIVE.md › Serve the two
// web apps).
//
// Without VITE_API_BASE_URL every guest call would go to this site itself and
// the pages would come up blank, so the server and the build refuse to start.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "VITE_");

  if (!env.VITE_API_BASE_URL) {
    throw new Error("Set VITE_API_BASE_URL (the API, e.g. http://localhost:5010/api) in apps/customer-web/.env or the environment.");
  }

  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      // The development server shows files from this app, the shared packages
      // and the installed libraries only: never the rest of the repository
      // (backend/.local holds backups and other machine-local files).
      fs: { allow: [here, inRepo("../../packages"), inRepo("../../node_modules")] },
    },
    preview: { port: 4174, strictPort: true },
    build: { assetsDir: "guest-assets" },
  };
});
