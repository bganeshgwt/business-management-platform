// Draws the installable apps' icons and writes their manifests
// (apps/business-web/public/icons and public/manifests), and the product's
// tab icon for both apps, with a browser (Playwright), so they are made the
// same way every time and never by hand. Run it after changing a mark,
// adding an installable app (apps/business-web/src/services/appManifest.js) or
// a mark a business may have (packages/ui/src/businessIcons.jsx):
//
//   node tools/render-app-icons.mjs
//
// For each app, and for the staff app once for every mark it may wear (the
// restaurant's own, and each a business may have, so a business installs it
// wearing its own mark): a 192 and a 512 px icon (the brand's rounded tile), a
// 512 px maskable one (full bleed, the mark inside the safe circle) and a
// 180 px iPhone Home Screen icon (full bleed: the iPhone rounds it), and the
// manifest that names them, with the brand's colours from the tokens. Plus
// the notification badge: the bell, white on clear, which Android shows in
// the status bar. The marks are the shared icon set's own drawings
// (packages/ui/src/drawings.jsx), white on the brand colour, flat, so each icon
// is a few kilobytes.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { INSTALLABLE_APPS, RESTAURANT_MARK, iconPath, manifestPath } from "../apps/business-web/src/services/appManifest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "apps", "business-web", "public");
const UI = path.join(ROOT, "packages", "ui", "src");
const SOURCE = fs.readFileSync(path.join(UI, "drawings.jsx"), "utf8");
const TOKENS = fs.readFileSync(path.join(UI, "styles", "base.css"), "utf8");

// A colour token of the light look (packages/ui base.css).
const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(TOKENS)[1];
// The brand gradient's two colours, for the tab icon (as BrandMark's).
const GRADIENT = /--brand-gradient: linear-gradient\(145deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\);/.exec(TOKENS).slice(1);

// The marks a business may have (packages/ui/src/businessIcons.jsx).
const BUSINESS_ICONS = [.../export const BUSINESS_ICONS = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(UI, "businessIcons.jsx"), "utf8"))[1].matchAll(/"([^"]+)"/g)]
  .map((match) => match[1]);
// The marks the staff app may wear, besides the product's own.
const STAFF_MARKS = [RESTAURANT_MARK, ...BUSINESS_ICONS];

// An icon's drawing, as SVG, from the shared icon set's source.
const glyph = (name) => {
  const key = `(?:${name}|"${name}")`;
  const group = new RegExp(`\\n  ${key}: \\(\\s*<>([\\s\\S]*?)</>\\s*\\),`).exec(SOURCE);
  const single = new RegExp(`\\n  ${key}: (<[a-z]+ [^\\n]*?/>),`).exec(SOURCE);
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
  const background = shape === "badge" ? "transparent" : token("primary");
  const stroke = shape === "badge" ? 2.4 : 1.9;

  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent}
    .tile{width:${size}px;height:${size}px;border-radius:${radius}px;background:${background};display:grid;place-items:center;overflow:hidden}
    svg{width:${markSize}px;height:${markSize}px;color:#fff}
  </style></head><body><div class="tile">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${glyph(mark)}</svg>
  </div></body></html>`;
};

const draw = async (page, file, size, mark, shape) => {
  fs.mkdirSync(path.dirname(path.join(PUBLIC, file)), { recursive: true });
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(tile({ size, mark, shape }));
  await page.locator(".tile").screenshot({ path: path.join(PUBLIC, file), omitBackground: true });
};

// An app's manifest, wearing `mark` (the staff app's) or its own.
const manifest = (app, entry, mark = null) => ({
  id: entry.scope,
  name: entry.name,
  short_name: entry.short,
  description: entry.description,
  start_url: entry.start,
  scope: entry.scope,
  display: "standalone",
  orientation: entry.orientation,
  theme_color: token("primary"),
  background_color: token("bg"),
  lang: "en-IN",
  dir: "ltr",
  icons: [
    { src: iconPath(app, 192, mark), sizes: "192x192", type: "image/png", purpose: "any" },
    { src: iconPath(app, 512, mark), sizes: "512x512", type: "image/png", purpose: "any" },
    { src: iconPath(app, "maskable-512", mark), sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(path.relative(ROOT, file).split(path.sep).join("/"));
};

// The product's mark as a tab icon: the tile of BrandMark (drawings.jsx markSvg).
const favicon = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
  + `<stop offset="0" stop-color="${GRADIENT[0]}"/><stop offset="1" stop-color="${GRADIENT[1]}"/></linearGradient></defs>`
  + `<rect width="24" height="24" rx="6" fill="url(#g)"/><g transform="translate(4 4) scale(0.6667)" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${glyph("brand")}</g></svg>\n`;

const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});

try {
  // The staff app's marks are drawn afresh: a mark no business may have any more goes.
  fs.rmSync(path.join(PUBLIC, "icons", "staff"), { recursive: true, force: true });
  fs.rmSync(path.join(PUBLIC, "manifests", "staff"), { recursive: true, force: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const wearing = [
    ...Object.entries(INSTALLABLE_APPS).map(([app, entry]) => ({ app, entry, mark: null, drawing: entry.mark })),
    ...STAFF_MARKS.map((mark) => ({ app: "staff", entry: INSTALLABLE_APPS.staff, mark, drawing: mark })),
  ];

  for (const { app, entry, mark, drawing } of wearing) {
    const at = (size) => iconPath(app, size, mark).slice(1);
    await draw(page, at(192), 192, drawing, "rounded");
    await draw(page, at(512), 512, drawing, "rounded");
    await draw(page, at("maskable-512"), 512, drawing, "maskable");
    await draw(page, at("apple-180"), 180, drawing, "apple");
    write(path.join(PUBLIC, manifestPath(app, mark).slice(1)), `${JSON.stringify(manifest(app, entry, mark), null, 2)}\n`);
  }

  await draw(page, "icons/badge-96.png", 96, "bell", "badge");
  write(path.join(PUBLIC, "favicon.svg"), favicon());
  write(path.join(ROOT, "apps", "customer-web", "src", "favicon.svg"), favicon());
} finally {
  await browser.close();
}
