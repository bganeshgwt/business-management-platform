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
// So do they with an address that is neither a web address nor a path on this
// site's own address: Git Bash turns a /api typed on its command line into a
// Windows path (C:/Program Files/Git/api), and every call would name nowhere.
const isWebAddress = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "VITE_");

  if (!env.VITE_API_BASE_URL) {
    throw new Error("Set VITE_API_BASE_URL (the API, e.g. http://localhost:5010/api) in apps/customer-web/.env or the environment.");
  }

  if (!isWebAddress(env.VITE_API_BASE_URL) && !env.VITE_API_BASE_URL.startsWith("/")) {
    const fromGitBash = /^[A-Za-z]:[\\/]/.test(env.VITE_API_BASE_URL);
    throw new Error(
      `Set VITE_API_BASE_URL to a web address or a path such as /api, not "${env.VITE_API_BASE_URL}"${
        fromGitBash ? ": Git Bash made that of /api, so set MSYS_NO_PATHCONV=1 or put it in .env" : ""
      }, in apps/customer-web/.env or the environment.`
    );
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
