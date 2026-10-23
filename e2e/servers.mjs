// The browser tests' own servers: the API and both web apps on ports of their
// own, all on one literal address, so a developer's running servers (5010,
// 5173, 5174) and database are never reached. 127.0.0.1 everywhere, never
// "localhost": Node may resolve that to ::1 while a server listens on IPv4
// only, and the API's CORS_ORIGIN must equal the staff app's origin exactly.
//
// The ports are fixed, not picked at run time, because the Playwright config
// reads them when it loads, before the global set-up runs. Each can be moved
// with an environment variable when another program holds it.
import process from "node:process";

export const HOST = "127.0.0.1";

// The development servers' ports (backend/.env PORT, the apps' vite.config.js).
const DEVELOPMENT_PORTS = [5010, 5173, 5174];

function port(variable, fallback) {
  const value = process.env[variable] ? Number(process.env[variable]) : fallback;

  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${variable} must be a port number from 1024 to 65535.`);
  }

  if (DEVELOPMENT_PORTS.includes(value)) {
    throw new Error(`${variable}=${value} is a development server's port; the browser tests run servers of their own.`);
  }

  return value;
}

export const PORTS = {
  api: port("E2E_API_PORT", 5110),
  staff: port("E2E_STAFF_PORT", 5183),
  guests: port("E2E_GUESTS_PORT", 5184),
};

if (new Set(Object.values(PORTS)).size !== 3) {
  throw new Error("E2E_API_PORT, E2E_STAFF_PORT and E2E_GUESTS_PORT must be three different ports.");
}

export const URLS = {
  api: `http://${HOST}:${PORTS.api}/api`,
  staff: `http://${HOST}:${PORTS.staff}`,
  guests: `http://${HOST}:${PORTS.guests}`,
};
