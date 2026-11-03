import { useEffect } from "react";
import { markSvg } from "@bmp/ui/drawings";
import { BUSINESS_ACCENTS, BUSINESS_ICONS } from "@bmp/ui/businessIcons";
import { RESTAURANT_MARK, installedApp } from "../services/appManifest";

// Points the page's web app manifest (and the iPhone's Home Screen icon and
// name) at the workspace on screen, so "Install" or "Add to Home Screen"
// installs that workspace, and gives the browser tab the mark and the name of
// the place: a layout calls it with its app's key (services/appManifest.js)
// and the mark of where it is.
//
//   useAppManifest("captain");
//   useAppManifest("staff", { icon: "dumbbell", accent: "rose", name: "Fit Zone" });
//
// `mark`: the open business's look and name (its type's or kind's icon, its
// accent), or the restaurant's own ({ icon: "cloche", name }). The staff app
// installed from there wears that mark when its icons are drawn for it, and
// an iPhone names it after the business; the tab shows the mark in its accent
// and the business's name. With none, the product's own.
const setLink = (rel, href) => {
  let link = document.querySelector(`link[rel="${rel}"]`);

  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }

  if (link.getAttribute("href") !== href) {
    link.setAttribute("href", href);
  }
};

const setMeta = (name, content) => {
  let meta = document.querySelector(`meta[name="${name}"]`);

  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }

  meta.setAttribute("content", content);
};

// The tab's icon, and its type with it (an SVG file, or a drawn mark).
const setTabIcon = (href) => {
  setLink("icon", href);
  document.querySelector('link[rel="icon"]').setAttribute("type", "image/svg+xml");
};

const drawnFor = (icon) => (icon === RESTAURANT_MARK || BUSINESS_ICONS.includes(icon) ? icon : null);

export default function useAppManifest(app, mark = null) {
  const icon = mark?.icon || null;
  const accent = mark?.accent || null;
  const name = mark?.name || null;

  useEffect(() => {
    const entry = installedApp(app, drawnFor(icon));
    setLink("manifest", entry.manifest);
    setLink("apple-touch-icon", entry.icon);
    setMeta("apple-mobile-web-app-title", entry.key === "staff" && name ? name : entry.name);
  }, [app, icon, name]);

  useEffect(() => {
    if (!icon && !name) {
      return undefined;
    }
    const link = document.querySelector('link[rel="icon"]');
    const before = { icon: link?.getAttribute("href") || "/favicon.svg", title: document.title };
    if (icon) {
      setTabIcon(`data:image/svg+xml,${encodeURIComponent(markSvg({ icon, color: BUSINESS_ACCENTS[accent] || null }))}`);
    }
    if (name) {
      document.title = `${name} · ${installedApp(app).title}`;
    }
    return () => {
      setTabIcon(before.icon);
      document.title = before.title;
    };
  }, [app, icon, accent, name]);
}
