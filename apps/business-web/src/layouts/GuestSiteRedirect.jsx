import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ScreenLoading } from "../components/Feedback";
import { customerWebOrigin } from "../services/customerWeb";

// What the guest pages kept in this browser while they were part of this app
// (carts, the guest's name and mobile, delivery addresses, tracked orders and
// bookings). They cannot follow the guest to the guest site's own address, so
// they are cleared here rather than left behind, on a shared tablet too.
const GUEST_KEYS = [/^rmp_guest_/, /^rmp_online_/, /^book\.mine$/];

const forgetGuestData = () => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (GUEST_KEYS.some((pattern) => pattern.test(key))) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage blocked: nothing was kept.
  }
};

// The guest pages (table QR ordering, online ordering, booking) are their own
// app (apps/customer-web). A QR code or link that still opens them on the
// staff app's address is sent on to the guest site, path and query kept.
// Printed QR codes never change, so this route stays for good.
export default function GuestSiteRedirect() {
  const { pathname, search, hash } = useLocation();
  const origin = customerWebOrigin();
  // On one domain the server sends these paths to the guest site; reaching
  // the staff app here means it does not yet, and redirecting would loop.
  const sameAddress = origin === window.location.origin;
  const target = `${origin}${pathname}${search}${hash}`;

  useEffect(() => {
    if (!sameAddress) {
      forgetGuestData();
      window.location.replace(target);
    }
  }, [sameAddress, target]);

  if (sameAddress) {
    return (
      <main className="page-center">
        <h1>This guest page is not set up yet</h1>
        <p className="muted">
          Guest pages are served by the guest site. Ask whoever runs the server to send /order, /online and /book to
          it, or to set VITE_CUSTOMER_WEB_URL.
        </p>
      </main>
    );
  }

  return <ScreenLoading label="Opening the guest page…" />;
}
