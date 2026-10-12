// What an offer's rules are, in words (SW-B-17): shared by the offer form
// and the offers list.

export const WEEKDAYS = [
  { value: 1, short: "Mon" },
  { value: 2, short: "Tue" },
  { value: 3, short: "Wed" },
  { value: 4, short: "Thu" },
  { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
  { value: 0, short: "Sun" },
];

export const EMPTY_RULES = {
  offerType: "discount",
  productIds: [],
  categoryIds: [],
  weekdays: [],
  timeFrom: "",
  timeTo: "",
  oncePerGuest: false,
  buyQuantity: "2",
  getQuantity: "1",
  getDiscountPercent: "100",
};

// "16:00" → "4 pm", "21:30" → "9:30 pm".
const hour = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
};

// One line saying what an offer's rules are, for the offers list.
export const rulesText = (offer, names = {}) => {
  const parts = [];

  // Buy X get Y is said in the Discount column beside it.
  const dishes = (offer.productIds || []).length;
  const cats = (offer.categoryIds || []).map((id) => names[id]).filter(Boolean);

  if (dishes || cats.length) {
    parts.push(
      [cats.length ? cats.join(", ") : null, dishes ? `${dishes} dish${dishes === 1 ? "" : "es"}` : null]
        .filter(Boolean)
        .join(" + ")
    );
  }

  if ((offer.weekdays || []).length) {
    parts.push(WEEKDAYS.filter((day) => offer.weekdays.includes(day.value)).map((day) => day.short).join(" "));
  }

  if (offer.timeFrom && offer.timeTo) {
    parts.push(`${hour(offer.timeFrom)}–${hour(offer.timeTo)}`);
  }

  if (offer.oncePerGuest) {
    parts.push("once per guest");
  }

  return parts.join(" · ");
};
