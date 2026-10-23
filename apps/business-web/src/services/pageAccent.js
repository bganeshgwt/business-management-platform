// Decorative module colours only. Permissions, status badges and action
// colours are independent. Match a complete path segment so /staffing cannot
// accidentally inherit /staff's colour; use the same map for saved shortcuts.
const AREAS = [
  ["blue", ["/pos", "/orders", "/bills"]],
  ["amber", ["/kitchen", "/purchasing", "/notifications"]],
  ["orange", ["/menu", "/expenses"]],
  ["cyan", ["/tables", "/table-requests", "/deliveries"]],
  ["green", ["/inventory"]],
  ["violet", ["/staff", "/reservations", "/discounts"]],
  ["rose", ["/crm"]],
  ["indigo", ["/reports", "/activity-log", "/restaurant", "/users", "/roles", "/profile"]],
];

// Business Admin screens (/business-admin/<id>/<section>) take the colour of
// the restaurant area that does the same job, so Sales reads blue and Stock
// green whichever business is open.
const BUSINESS_AREAS = {
  sales: "blue", customers: "rose", appointments: "violet", resources: "violet", pricing: "violet",
  purchases: "amber", suppliers: "amber", products: "orange", categories: "orange", units: "orange",
  stock: "green", movements: "green", transfers: "green", counts: "green",
  reports: "indigo", activity: "indigo", settings: "indigo", "tax-rates": "indigo", "number-series": "indigo",
  locations: "indigo", staff: "indigo", roles: "indigo",
};

export function pageAccent(path = "/") {
  const pathname = path.split(/[?#]/, 1)[0];
  const business = pathname.match(/^\/business-admin\/\d+(?:\/([^/]+))?/);
  if (business) {
    return BUSINESS_AREAS[business[1]] || "teal";
  }
  return AREAS.find(([, paths]) => paths.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)))?.[0] || "teal";
}
