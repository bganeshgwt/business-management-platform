// Draws the installable apps' icons (apps/business-web/public/icons) from the
// product's mark, with a browser (Playwright), so they are made the same way
// every time and never by hand. Run it after changing a mark or adding an
// installable app (apps/business-web/src/services/appManifest.js):
//
//   node tools/render-app-icons.mjs
//
// For each app: a 192 and a 512 px icon (the brand's rounded tile), a 512 px
// maskable one (full bleed, the mark inside the safe circle) and a 180 px
// iPhone Home Screen icon (full bleed: the iPhone rounds it). Plus the
// notification badge: the bell, white on clear, which Android shows in the
// status bar. The marks are the shared icon set's own drawings
// (packages/ui/src/Icon.jsx), on the brand gradient of the product's mark.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = path.join(ROOT, "apps", "business-web", "public", "icons");
const SOURCE = fs.readFileSync(path.join(ROOT, "packages", "ui", "src", "Icon.jsx"), "utf8");

// Each app and the mark it carries: the product's own cloche for the staff
// app, and the mark of each workspace's work for the others.
const APPS = { staff: "cloche", captain: "table", kitchen: "chef", clinic: "heart", lab: "clipboard", counter: "receipt", sales: "scooter" };
// The brand gradient (packages/ui base.css --brand-gradient).
const GRADIENT = ["#0a8874", "#126251"];

// An icon's drawing, as SVG, from the shared icon set's source.
const glyph = (name) => {
  const group = new RegExp(`\\n  ${name}: \\(\\s*<>([\\s\\S]*?)</>\\s*\\),`).exec(SOURCE);
  const single = new RegExp(`\\n  ${name}: (<[a-z]+ [^\\n]*?/>),`).exec(SOURCE);
  const markup = group ? group[1] : single ? single[1] : null;

  if (!markup) {
    throw new Error(`The shared icon set has no drawing called ${name}.`);
  }

  return markup.replace(/\s+/g, " ").trim();
};

const tile = ({ size, mark, shape }) => {
  // The mark's share of the icon: within the safe circle for a maskable icon.
  const share = shape === "maskable" ? 0.42 : shape === "apple" ? 0.5 : 0.54;
  const markSize = Math.round(size * share);
  const radius = shape === "rounded" ? Math.round(size * 0.22) : 0;
  const background = shape === "badge"
    ? "transparent"
    : `linear-gradient(145deg, ${GRADIENT[0]}, ${GRADIENT[1]})`;
  const stroke = shape === "badge" ? 2.4 : 1.9;
  // A soft light from the top, as on the mark in the app.
  const sheen = shape === "badge"
    ? ""
    : `<div style="position:absolute;inset:0;border-radius:${radius}px;background:radial-gradient(120% 80% at 30% 0%, rgba(255,255,255,0.22), rgba(255,255,255,0) 60%)"></div>`;

  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent}
    .tile{position:relative;width:${size}px;height:${size}px;border-radius:${radius}px;background:${background};display:grid;place-items:center;overflow:hidden}
    svg{position:relative;width:${markSize}px;height:${markSize}px;color:#fff}
  </style></head><body><div class="tile">${sheen}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${glyph(mark)}</svg>
  </div></body></html>`;
};

const draw = async (page, file, size, mark, shape) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(tile({ size, mark, shape }));
  await page.locator(".tile").screenshot({ path: path.join(ICONS, file), omitBackground: true });
  console.log(`icons/${file}`);
};

const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});

try {
  fs.mkdirSync(ICONS, { recursive: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  for (const [app, mark] of Object.entries(APPS)) {
    await draw(page, `${app}-192.png`, 192, mark, "rounded");
    await draw(page, `${app}-512.png`, 512, mark, "rounded");
    await draw(page, `${app}-maskable-512.png`, 512, mark, "maskable");
    await draw(page, `${app}-apple-180.png`, 180, mark, "apple");
  }

  await draw(page, "badge-96.png", 96, "bell", "badge");
} finally {
  await browser.close();
}
