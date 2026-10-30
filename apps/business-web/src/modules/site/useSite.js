import { useQuery } from "@tanstack/react-query";
import { getSiteInfo, getSitePricing } from "./services/site.service";

// The site's two reads, shared by its pages through the app's query memory:
// the company's details with the trial, grace and GST, and the price list.
export const useSiteInfo = () => useQuery({ queryKey: ["site", "info"], queryFn: getSiteInfo });

export const useSitePricing = () => useQuery({ queryKey: ["site", "pricing"], queryFn: getSitePricing });

// Where the visitor came from (the ref or utm_source of the link that brought
// them), kept for this tab's visit so the forms can send it from any page.
const REF_KEY = "bmp_site_ref";

export const savedRef = () => {
  try {
    return sessionStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
};

export const keepRef = (ref) => {
  if (!ref) return;
  try {
    sessionStorage.setItem(REF_KEY, ref);
  } catch {
    // Storage blocked: the form sends the link's own ref, if it is still in the address.
  }
};
