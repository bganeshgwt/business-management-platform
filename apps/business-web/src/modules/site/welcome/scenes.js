// The home page's tour, one scene for each of four kinds of business: the
// type it shows (offered only while the price list offers that type), its
// tab, the place in the window's title bar, a sentence for screen readers in
// place of the drawing (SceneArt.jsx), and the two notes that float beside
// the window, each a thing the platform does for that type.
export const SCENES = [
  {
    type: "restaurant",
    label: "Restaurant",
    icon: "utensils",
    place: "Table 6 · Dine-in",
    summary: "A restaurant: table 6's order goes to the kitchen display as a KOT, and its bill, with CGST and SGST, is paid by UPI.",
    notes: [
      { icon: "chef", title: "KOT 42", text: "On the kitchen display" },
      { icon: "qr", title: "UPI QR", text: "For the exact amount", qr: true },
    ],
  },
  {
    type: "grocery",
    label: "Kirana",
    icon: "store",
    place: "Quick bill · Counter 1",
    summary: "A kirana store: items scanned by their barcodes and a scale label into a quick bill, paid by UPI.",
    notes: [
      { icon: "alert", title: "Expiring soon", text: "Bread · in 2 days" },
      { icon: "message", title: "Udhaar reminder", text: "Ready on WhatsApp" },
    ],
  },
  {
    type: "salon",
    label: "Salon",
    icon: "sparkles",
    place: "Today · Calendar",
    summary: "A salon: the day's appointments by stylist, with a package's sessions counted and a reminder ready on WhatsApp.",
    notes: [
      { icon: "gift", title: "Package", text: "3 of 6 sessions left" },
      { icon: "message", title: "Reminder", text: "Ready on WhatsApp" },
    ],
  },
  {
    type: "healthcare",
    label: "Clinic",
    icon: "activity",
    place: "Front desk · Tokens",
    summary: "A clinic: the front desk's tokens and each doctor's queue, with a lab sample barcoded at collection.",
    notes: [
      { icon: "clipboard", title: "Lab report", text: "Signed and ready" },
      { icon: "print", title: "Prescription", text: "Ready to print" },
    ],
  },
];
