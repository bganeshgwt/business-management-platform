import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const inRepo = (path) => fileURLToPath(new URL(path, import.meta.url));

// Is it a web address the guests' site can live at?
const isWebAddress = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// The staff app. The two addresses it needs come from .env (.env.example
// explains them). Without the API every screen calls nowhere; without the
// guests' site's address QR codes and shared links would open the staff app
// instead (an old frontend/.env has no such line). So the server and the
// build refuse to start, with a sentence instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "VITE_");
  const problems = [];
  const guestSite = env.VITE_CUSTOMER_WEB_URL;

  if (!env.VITE_API_BASE_URL) {
    problems.push("VITE_API_BASE_URL (the API, e.g. http://localhost:5010/api)");
  }

  if (!guestSite || (guestSite !== "same-origin" && !isWebAddress(guestSite))) {
    problems.push('VITE_CUSTOMER_WEB_URL (the guests\' site, e.g. http://localhost:5174, or "same-origin" when one domain serves both apps)');
  }

  if (problems.length) {
    throw new Error(`Set ${problems.join(" and ")} in apps/business-web/.env or the environment.`);
  }

  return {
    plugins: [react()],
    server: {
      // Always 5173: the guests' site is on 5174 and the API allows this address.
      port: 5173,
      strictPort: true,
      // The development server shows files from this app, the shared packages
      // and the installed libraries only: never the rest of the repository
      // (backend/.local holds backups and other machine-local files).
      fs: { allow: [here, inRepo("../../packages"), inRepo("../../node_modules")] },
    },
  };
});
