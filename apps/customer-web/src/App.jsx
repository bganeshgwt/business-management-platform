import { lazy, Suspense } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import PageLoadBoundary from "@bmp/ui/PageLoadBoundary";

// The guests' site. Every page opens from a restaurant's own link (a table's
// QR code, the online ordering link, the booking link) or a business's (its
// booking link for appointments); nobody signs in.
const QrLandingPage = lazy(() => import("./modules/table-order/pages/QrLandingPage"));
const OnlineOrderPage = lazy(() => import("./modules/online-order/pages/OnlineOrderPage"));
const BookingPage = lazy(() => import("./modules/booking/pages/BookingPage"));
const PlannedPage = lazy(() => import("./pages/PlannedPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const AppointmentsPage = lazy(() => import("./modules/appointments/pages/AppointmentsPage"));
// A shop's online shop: its items, the cart, checkout and each order's own page.
const ShopPage = lazy(() => import("./modules/shop/pages/ShopPage"));
// Lazy as well, so the entry bundle carries no page's stylesheet: each page's
// CSS arrives with that page only, as it did inside the staff app.
const StartPage = lazy(() => import("./pages/StartPage"));

export default function App() {
  const { pathname } = useLocation();

  // A page whose code fails to load (a new version gone live while the guest
  // had the page open) reloads once by itself; any other failure says so with
  // a Reload button instead of a blank screen (@bmp/ui/PageLoadBoundary).
  return (
    <PageLoadBoundary resetKey={pathname}>
    <Suspense fallback={<div className="guest-app" aria-busy="true" />}>
      <Routes>
        {/* Where a printed table QR code lands. */}
        <Route path="/order/:token" element={<QrLandingPage />} />
        {/* A restaurant's online ordering page and each order's status. */}
        <Route path="/online/:token/*" element={<OnlineOrderPage />} />
        {/* A restaurant's booking link and each guest's own booking. */}
        <Route path="/book/*" element={<BookingPage />} />
        {/* A business's privacy notice, from the link on its guest pages. */}
        <Route path="/privacy-notice/:ref" element={<PrivacyPage />} />
        {/* A business's booking link, each guest's own booking, and the bookings made on this phone. */}
        <Route path="/appointments/*" element={<AppointmentsPage />} />

        {/* A shop's online shop, from its shop link, and each order's status. */}
        <Route path="/shop/*" element={<ShopPage />} />

        {/* Planned, not built yet (plannedPages.js): the address works and says
            what is coming and what to do until then. A built one replaces its line. */}
        <Route path="/account/*" element={<PlannedPage page="account" />} />

        {/* The site's own address, or a link with part of it missing. */}
        <Route path="*" element={<StartPage />} />
      </Routes>
    </Suspense>
    </PageLoadBoundary>
  );
}
