import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { drawing, markSvg } from "@bmp/ui/drawings";
import { BUSINESS_ACCENTS } from "@bmp/ui/businessIcons";
import { initials, mapsHref, openLine, sellerLines, telHref } from "./guestWords";
import { usePlatformBrand, useTypeLook } from "./siteInfo";
import "../styles/guest.css";
import "./shared.css";

// The frame of a business's guest page (docs/ARCHITECTURE.md › Building a
// guest page for a business): the business's band at the top (its logo, else
// its mark in its accent; its name, open now or when it opens, Call and
// Directions), the page itself, and the foot: the seller's details, the
// privacy notice and the platform's name. The browser tab shows the
// business's mark too.
//
//   <GuestShell card={card} context="Online booking">…</GuestShell>
//
//   card     the business card the page's API answer carries (the API's
//            guestBusinessCard); null while it loads: the band shows its
//            placeholder. Its mark is its `look` ({ icon, accent }) when the
//            card carries one, else its type's (`type`), as the platform sets
//            them in Platform › Business types
//   seller   what the page adds to the card's seller details, each shown only
//            when given: { legalName, address, customerCare: { phone, email },
//            grievance: { name, designation, phone, email }, fssai } (a shop
//            selling online shows its customer care and grievance officer;
//            a food shop its FSSAI licence)
//   context  a few words under the name ("Online booking", "Your order")
//   actions  more buttons for the band, before Call and Directions
//   wide     a wider page (a shop's grid) than a form's column

// The business's mark: { icon, color } once its look is known, null when it
// has none we can draw, undefined while its type's is read.
function useMark(card) {
  const typeLook = useTypeLook(card && !card.look ? card.type : null);
  const look = card ? card.look || typeLook : undefined;

  if (look === undefined) return undefined;
  return look && drawing(look.icon) ? { icon: look.icon, color: BUSINESS_ACCENTS[look.accent] || null } : null;
}

// The browser tab's icon: the business's mark while its page is open.
function useTabMark(mark) {
  const icon = mark ? mark.icon : null;
  const color = mark ? mark.color : null;

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (!icon || !link) return undefined;
    const before = link.getAttribute("href");
    link.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(markSvg({ icon, color }))}`);
    return () => link.setAttribute("href", before);
  }, [icon, color]);
}

function Mark({ card, mark }) {
  const [broken, setBroken] = useState(false);

  if (card.logoUrl && !broken) {
    return <img className="gs-logo" src={card.logoUrl} alt="" width="36" height="36" onError={() => setBroken(true)} />;
  }

  if (mark === undefined) {
    return <span className="skeleton gs-sk-mark" aria-hidden="true" />;
  }

  if (mark) {
    return (
      <span className="g-monogram gs-mark" style={mark.color ? { "--gs-mark": mark.color } : undefined} aria-hidden="true">
        <Icon name={mark.icon} size={20} />
      </span>
    );
  }

  return (
    <span className="g-monogram" aria-hidden="true">
      {initials(card.name) || <Icon name="store" size={18} />}
    </span>
  );
}

export default function GuestShell({ card, seller = null, context = null, actions = null, wide = false, children }) {
  const brand = usePlatformBrand();
  const mark = useMark(card);
  useTabMark(mark);
  const line = card ? openLine(card.hours) : null;
  const call = card ? telHref(card.location && card.location.phone) : null;
  const maps = card ? mapsHref(card) : null;
  const lines = card ? sellerLines(card, seller || {}) : [];
  const place = card && card.location && card.location.name && card.location.name !== card.name ? card.location.name : null;

  return (
    <div className="guest-app gs-page">
      <header className="g-topbar gs-band">
        <div className="g-topbar-inner gs-band-inner">
          {card ? <Mark card={card} mark={mark} /> : <span className="skeleton gs-sk-mark" aria-hidden="true" />}
          <div className="g-topbar-title gs-band-title">
            {card ? <strong>{card.name}</strong> : <span className="skeleton gs-sk-line is-wide" aria-hidden="true" />}
            {card && (line || context || place) && (
              <span className="gs-band-meta">
                {line && (
                  <span className={`gs-open ${line.open ? "is-open" : "is-closed"}`}>
                    <span className="gs-open-dot" aria-hidden="true" />
                    {line.text}
                  </span>
                )}
                {(context || place) && <span className="gs-band-context">{[context, place].filter(Boolean).join(" · ")}</span>}
              </span>
            )}
          </div>
          <div className="gs-band-actions">
            {actions}
            {call && (
              <a className="g-pill" href={call} aria-label={`Call ${card.name}`}>
                <Icon name="phone" size={16} />
                <span className="g-hide-narrow">Call</span>
              </a>
            )}
            {maps && (
              <a className="g-pill" href={maps} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${card.name}`}>
                <Icon name="map-pin" size={16} />
                <span className="g-hide-narrow">Directions</span>
              </a>
            )}
          </div>
        </div>
      </header>

      <main className={`g-shell gs-main ${wide ? "is-wide" : ""}`}>{children}</main>

      <footer className="gs-foot">
        <div className={`gs-foot-inner ${wide ? "is-wide" : ""}`}>
          {lines.length > 0 && (
            <dl className="gs-seller">
              {lines.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {card && card.privacy && (
            <p className="gs-foot-links">
              <a href={card.privacy.url} target="_blank" rel="noopener noreferrer">
                <Icon name="shield" size={14} /> Privacy notice
              </a>
            </p>
          )}
          {brand && (
            <p className="gs-powered">
              Powered by{" "}
              {brand.website ? (
                <a href={brand.website} target="_blank" rel="noopener noreferrer">
                  {brand.name}
                </a>
              ) : (
                brand.name
              )}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}
