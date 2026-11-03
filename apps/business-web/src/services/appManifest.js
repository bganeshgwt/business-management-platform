// The apps a person can install from the staff app, one per workspace
// (docs/ARCHITECTURE.md › Installing the app): each has its web app manifest
// in public/manifests (name, start address, scope, standalone, the brand's
// colours) and its icons in public/icons, drawn on the product's tile by
// tools/render-app-icons.mjs from the mark named here. The page's
// <link rel="manifest"> follows the workspace on screen
// (hooks/useAppManifest.js), so installing from the captain app installs the
// captain app.
//
// The staff app wears the mark of the place it is installed from: the
// product's own where no business is open, the restaurant's cloche in the
// restaurant's screens, and a business's own mark (its type's or kind's, from
// Platform › Business types) in Business Admin. The tool draws its icons and
// writes its manifest for every mark a business may have
// (@bmp/ui/businessIcons), each the same app (one id), so a phone keeps one
// staff app, wearing the mark it was installed with.
//
// A workspace added later adds its entry here and calls the hook, as the
// salesperson app (/sales, a wholesaler's field salespeople) does; the tool
// then writes its manifest and draws its icons.
//
//   name         the app's name: its manifest's, and on an iPhone's Home Screen
//   short        the name under the icon (12 characters at most)
//   description  what the manifest says it is
//   title        what the browser tab names after the business's name
//   mark         the drawing on its icon (@bmp/ui Icon)

export const INSTALLABLE_APPS = {
  staff: { name: "Staff app", short: "Staff app", install: "Install the staff app", start: "/", scope: "/", orientation: "any", mark: "brand", title: "Business Admin",
    description: "The staff app: sales, stock, customers and every screen of your business." },
  captain: { name: "Captain app", short: "Captain", install: "Install the captain app", start: "/captain", scope: "/captain", orientation: "portrait", mark: "table", title: "Captain app",
    description: "A waiter's phone: your tables, guests' calls, food ready at the pass, and taking orders." },
  kitchen: { name: "Kitchen display", short: "Kitchen", install: "Install the kitchen display", start: "/kitchen", scope: "/kitchen", orientation: "any", mark: "chef", title: "Kitchen display",
    description: "The kitchen's screen: tickets as they come in, cooking and ready." },
  clinic: { name: "Clinic", short: "Clinic", install: "Install the clinic app", start: "/clinic", scope: "/clinic", orientation: "any", mark: "stethoscope", title: "Clinic",
    description: "The clinic's desk and consultations: the token queue, visits and patients." },
  lab: { name: "Lab", short: "Lab", install: "Install the lab app", start: "/lab", scope: "/lab", orientation: "any", mark: "flask", title: "Lab",
    description: "The lab bench: collection, the worklist, approval and released reports." },
  counter: { name: "Counter", short: "Counter", install: "Install the counter app", start: "/business-admin", scope: "/business-admin", orientation: "any", mark: "receipt", title: "Quick bill",
    description: "The shop's counter: quick bills, opening the business you used last." },
  sales: { name: "Sales", short: "Sales", install: "Install the salesperson app", start: "/sales", scope: "/sales", orientation: "portrait", mark: "truck", title: "Salesperson app",
    description: "A salesperson's day on the beat: shops in visit order, orders at each shop's prices, collections and new shops, with or without the network." },
};

// The restaurant's own mark, in its screens' top bar and on its staff app.
export const RESTAURANT_MARK = "cloche";

// Where an app's manifest and its iPhone icon are: the staff app wearing a
// mark has its own under staff/.
export const manifestPath = (app, mark = null) => (app === "staff" && mark ? `/manifests/staff/${mark}.webmanifest` : `/manifests/${app}.webmanifest`);
export const iconPath = (app, size, mark = null) => (app === "staff" && mark ? `/icons/staff/${mark}-${size}.png` : `/icons/${app}-${size}.png`);

// The app a screen installs and what it wears: its entry with its manifest and
// iPhone icon. `mark`: for the staff app, a mark drawn for it (the
// restaurant's, or one of @bmp/ui/businessIcons); none, the product's.
export function installedApp(app, mark = null) {
  const key = INSTALLABLE_APPS[app] ? app : "staff";
  const worn = key === "staff" ? mark : null;
  return { ...INSTALLABLE_APPS[key], key, manifest: manifestPath(key, worn), icon: iconPath(key, "apple-180", worn) };
}

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
