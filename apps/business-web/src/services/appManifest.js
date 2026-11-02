// The apps a person can install from the staff app, one per workspace
// (docs/ARCHITECTURE.md › Installing the app): each has its web app manifest
// in public/manifests (name, start address, scope, standalone, the brand's
// colours) and its icons in public/icons, drawn from the product's mark by
// tools/render-app-icons.mjs. The page's <link rel="manifest"> follows the
// workspace on screen (hooks/useAppManifest.js), so installing from the
// captain app installs the captain app.
//
// A workspace added later adds its entry here, its manifest file and its
// icons (the tool draws them), and calls the hook, as the salesperson app
// (/sales, a wholesaler's field salespeople) does.

export const INSTALLABLE_APPS = {
  staff: { name: "Staff app", install: "Install the staff app", manifest: "/manifests/staff.webmanifest", icon: "/icons/staff-apple-180.png", start: "/" },
  captain: { name: "Captain app", install: "Install the captain app", manifest: "/manifests/captain.webmanifest", icon: "/icons/captain-apple-180.png", start: "/captain" },
  kitchen: { name: "Kitchen display", install: "Install the kitchen display", manifest: "/manifests/kitchen.webmanifest", icon: "/icons/kitchen-apple-180.png", start: "/kitchen" },
  clinic: { name: "Clinic", install: "Install the clinic app", manifest: "/manifests/clinic.webmanifest", icon: "/icons/clinic-apple-180.png", start: "/clinic" },
  lab: { name: "Lab", install: "Install the lab app", manifest: "/manifests/lab.webmanifest", icon: "/icons/lab-apple-180.png", start: "/lab" },
  counter: { name: "Counter", install: "Install the counter app", manifest: "/manifests/counter.webmanifest", icon: "/icons/counter-apple-180.png", start: "/business-admin" },
  sales: { name: "Sales", install: "Install the salesperson app", manifest: "/manifests/sales.webmanifest", icon: "/icons/sales-apple-180.png", start: "/sales" },
};

const RULES = [
  ["captain", /^\/captain(\/|$)/],
  ["kitchen", /^\/kitchen(\/|$)/],
  ["clinic", /^\/clinic(\/|$)/],
  ["lab", /^\/lab(\/|$)/],
  ["counter", /^\/business-admin\/\d+\/counter(\/|$)/],
  ["sales", /^\/sales(\/|$)/],
];

// Which app a screen belongs to: its workspace's, else the staff app.
export const appFor = (pathname) => RULES.find(([, pattern]) => pattern.test(String(pathname || "").split(/[?#]/, 1)[0]))?.[0] || "staff";
