// A restaurant's format (restaurant, café, bakery, cloud kitchen): its name
// and icon wherever the place is named (header, business switcher, settings).
export const FORMAT_LABELS = { restaurant: "Restaurant", cafe: "Café", bakery: "Bakery", cloud_kitchen: "Cloud kitchen" };
export const FORMAT_ICONS = { restaurant: "utensils", cafe: "coffee", bakery: "gift", cloud_kitchen: "scooter" };
export const formatLabel = (format) => FORMAT_LABELS[format] || FORMAT_LABELS.restaurant;
export const formatIcon = (format) => FORMAT_ICONS[format] || FORMAT_ICONS.restaurant;
