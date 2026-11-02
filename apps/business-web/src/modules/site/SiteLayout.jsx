import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { BrandMark } from "@bmp/ui/Icon";
import useAuth from "../../hooks/useAuth";
import { keepRef, useSiteInfo } from "./useSite";
import { companyName, pageTitle, refFrom, startLabel, websiteHref } from "./siteWords.js";
import "./site.css";

// The frame of the platform's public pages (/welcome, /pricing, /signup, the
// policies and /contact), outside the app's own: the brand, Pricing, Sign in
// and the way to start, and a footer with the company's details and the
// policies. Each page gives its title and its description for search engines
// and shared links; leaving the site puts the app's own title back. Over a
// page that opens on a dark hero (overHero, the home page), the header is
// clear at the top, the hero runs up behind it (--site-header-h), and it
// takes its own background once the page scrolls.

function usePageMeta(title, description) {
  useEffect(() => {
    const before = document.title;
    let meta = document.head.querySelector('meta[name="description"]');
    const made = !meta;

    if (made) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.appendChild(meta);
    }

    const previous = meta.getAttribute("content");
    // The home page's title is the brand: until it has come, the title stays.
    if (title) document.title = title;
    meta.setAttribute("content", description || "");

    return () => {
      document.title = before;

      if (made) {
        meta.remove();
      } else {
        meta.setAttribute("content", previous || "");
      }
    };
  }, [title, description]);
}

// The header's height on the frame, as --site-header-h, for a hero that runs
// up behind it; measured before the first paint and again whenever the
// header wraps.
function useHeaderHeight(siteRef, headerRef, on) {
  useLayoutEffect(() => {
    const site = siteRef.current;
    const header = headerRef.current;
    if (!on || !site || !header) return undefined;
    const measure = () => site.style.setProperty("--site-header-h", `${Math.ceil(header.getBoundingClientRect().height)}px`);
    measure();
    const watcher = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watcher?.observe(header);
    return () => {
      watcher?.disconnect();
      site.style.removeProperty("--site-header-h");
    };
  }, [siteRef, headerRef, on]);
}

// Whether the page has scrolled from its top.
function useScrolled(on) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!on) return undefined;
    const check = () => setScrolled(window.scrollY > 8);
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => window.removeEventListener("scroll", check);
  }, [on]);

  return on && scrolled;
}

// A page of the site opens at its top, or at the part its address names
// (/welcome#call-back), not where the page before it was scrolled to. Only
// when the page opens: a link within the page moves it as it likes.
function useOpenAtTop() {
  const { hash } = useLocation();
  const opening = useRef(hash);

  useEffect(() => {
    const target = opening.current ? document.getElementById(decodeURIComponent(opening.current.slice(1))) : null;
    if (target) {
      target.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }, []);
}

const lines = (...parts) => parts.filter(Boolean);

export default function SiteLayout({ title, description, overHero = false, children }) {
  const { user } = useAuth();
  const { search } = useLocation();
  const { data: info } = useSiteInfo();
  const siteRef = useRef(null);
  const headerRef = useRef(null);
  const scrolled = useScrolled(overHero);
  const brand = info?.brandName;
  const company = info?.company || {};

  usePageMeta(pageTitle(title, brand), description);
  useHeaderHeight(siteRef, headerRef, overHero);
  useOpenAtTop();

  // The link that brought the visitor, for the lead their form makes.
  useEffect(() => {
    keepRef(refFrom(search));
  }, [search]);

  const place = lines(company.address, lines(company.city, company.postalCode).join(" ")).join(", ");
  const reach = lines(info?.support?.phone || company.phone, info?.support?.email || company.email);

  return (
    <div ref={siteRef} className={`site${overHero ? " is-over-hero" : ""}`}>
      <a className="skip-link" href="#site-main">Skip to the page</a>
      <header ref={headerRef} className={`site-header${overHero ? (scrolled ? " is-scrolled" : " is-clear") : ""}`}>
        <div className="site-wrap site-bar">
          <Link to="/welcome" className="site-brand" aria-label={brand ? `${brand}, home` : "Home"}>
            <BrandMark size={32} />
            {brand && <span>{brand}</span>}
          </Link>
          <nav className="site-nav" aria-label="Site">
            <NavLink to="/pricing" className="site-nav-link">Pricing</NavLink>
            <NavLink to="/contact" className="site-nav-link">Contact</NavLink>
            {user ? (
              <Link to="/" className="button button-sm">Open your business</Link>
            ) : (
              <>
                <Link to="/login" className="button button-secondary button-sm">Sign in</Link>
                <Link to="/signup" className="button button-sm">{startLabel(info ? info.trialDays : 1)}</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main id="site-main" className="site-main" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-footer">
        <div className="site-wrap site-footer-inner">
          <div className="site-footer-company">
            <p className="site-footer-brand">
              <BrandMark size={24} />
              {brand}
            </p>
            {info && <p>{brand} is provided by {companyName(info)}{place ? `, ${place}` : ""}.</p>}
            {reach.length > 0 && <p>{reach.join(" · ")}</p>}
            {company.website && <p>{websiteHref(company.website) ? <a href={websiteHref(company.website)} rel="noopener noreferrer">{company.website}</a> : company.website}</p>}
          </div>
          <nav className="site-footer-links" aria-label="Policies and contact">
            <Link to="/terms">Terms of service</Link>
            <Link to="/privacy-policy">Privacy policy</Link>
            <Link to="/refunds">Refunds and cancellation</Link>
            <Link to="/contact">Contact us</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
