import { useEffect, useState } from "react";
import { API_BASE } from "./publicClient";

// What the guest pages read of the platform itself, with no login (GET
// /api/site/…, which answers any web address). Each is read once a visit;
// nothing is shown while it loads or when it cannot be read.
//   usePlatformBrand()   the platform's own name, for the "Powered by" line
//                        at a guest page's foot (/site/info)
//   useTypeLook(type)    a business type's mark and accent, as the platform
//                        sets them (Platform › Business types), for a card
//                        that carries no look of its own (/site/pricing)

const asked = new Map();

const readSite = (what) => {
  if (!asked.has(what)) {
    asked.set(what, fetch(`${API_BASE}/site/${what}`, { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => (body && body.data) || null)
      .catch(() => null));
  }

  return asked.get(what);
};

// The answer: undefined while it is read, then its data or null. Nothing is
// read while `enabled` is false.
function useSiteAnswer(what, enabled = true) {
  const [answer, setAnswer] = useState(undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;

    readSite(what).then((data) => {
      if (alive) setAnswer(data);
    });

    return () => {
      alive = false;
    };
  }, [what, enabled]);

  return answer;
}

export function usePlatformBrand() {
  const info = useSiteAnswer("info");
  return info && info.brandName ? { name: info.brandName, website: (info.company && info.company.website) || null } : null;
}

// { icon, accent } of the type; null when it is not listed, cannot be read or
// `type` is null; undefined while it is read.
export function useTypeLook(type) {
  const pricing = useSiteAnswer("pricing", Boolean(type));

  if (!type || pricing === null) return null;
  if (pricing === undefined) return undefined;
  const found = (pricing.types || []).find((entry) => entry.code === type);
  return found && found.icon ? { icon: found.icon, accent: found.accent || null } : null;
}
