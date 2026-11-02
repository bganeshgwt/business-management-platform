import { useEffect } from "react";
import { INSTALLABLE_APPS } from "../services/appManifest";

// Points the page's web app manifest (and the iPhone's Home Screen icon and
// name) at the workspace on screen, so "Install" or "Add to Home Screen"
// installs that workspace: a layout calls it with its app's key
// (services/appManifest.js).
//
//   useAppManifest("captain");
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

export default function useAppManifest(app) {
  useEffect(() => {
    const entry = INSTALLABLE_APPS[app] || INSTALLABLE_APPS.staff;
    setLink("manifest", entry.manifest);
    setLink("apple-touch-icon", entry.icon);
    setMeta("apple-mobile-web-app-title", entry.name);
  }, [app]);
}
