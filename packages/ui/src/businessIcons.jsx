// The marks a business type or kind may have (Platform › Business types offers
// these): trades first, then general marks. The staff app's installable app
// has its icons drawn for each (tools/render-app-icons.mjs), so a business
// installs the app with its own mark.
export const BUSINESS_ICONS = [
  "utensils", "coffee", "basket", "cart", "store", "fish", "scale", "truck", "shirt", "smartphone", "book", "pill", "glasses", "gem",
  "hammer", "sprout", "leaf", "wrench", "car", "fuel", "scissors", "comb", "sparkles", "stethoscope", "tooth", "flask", "activity", "heart",
  "dumbbell", "lotus", "music", "graduation", "medal", "hanger", "washer", "iron", "key", "tent", "bed", "building", "home", "box", "layers",
  "tag", "zap", "star", "users",
];

// Each accent's strong colour, as the staff app's styles set it for the light
// look (apps/business-web/src/styles/app/accents.css; a test keeps the two
// alike): for a business's mark drawn as a solid tile, white on its accent in
// either look (the top bar, the lock screen, a browser tab's icon, the
// guests' site).
export const BUSINESS_ACCENTS = {
  orange: "#c2410c", amber: "#b45309", yellow: "#a16207", lime: "#4d7c0f", green: "#15803d", emerald: "#047857",
  teal: "#0f766e", cyan: "#0e7490", sky: "#0369a1", blue: "#1d4ed8", indigo: "#4338ca", violet: "#6d28d9",
  purple: "#7e22ce", fuchsia: "#a21caf", pink: "#be185d", rose: "#be123c", red: "#b91c1c", slate: "#475569",
};
