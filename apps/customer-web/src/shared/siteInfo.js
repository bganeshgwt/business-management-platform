import { useEffect, useState } from "react";
import { API_BASE } from "./publicClient";

// The platform's own name, for the "Powered by" line at a guest page's foot
// (GET /api/site/info, which answers any web address). Read once a visit;
// nothing is shown while it loads or when it cannot be read.

let asked = null;

const readBrand = () => {
  if (!asked) {
    asked = fetch(`${API_BASE}/site/info`, { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const info = body && body.data;
        return info && info.brandName ? { name: info.brandName, website: (info.company && info.company.website) || null } : null;
      })
      .catch(() => null);
  }

  return asked;
};

export function usePlatformBrand() {
  const [brand, setBrand] = useState(null);

  useEffect(() => {
    let alive = true;

    readBrand().then((found) => {
      if (alive) setBrand(found);
    });

    return () => {
      alive = false;
    };
  }, []);

  return brand;
}
