import Icon from "@bmp/ui/Icon";

// The tour's screens in miniature, one for each scene in scenes.js: what the
// platform looks like for a restaurant, a kirana store, a salon and a clinic.
// Decoration (the tour gives each a sentence for screen readers): an example
// order, bill and day, worked out as the platform works them out (a
// restaurant's 5% GST as CGST and SGST, to the paisa).

const RESTAURANT_LINES = [
  { qty: 1, name: "Paneer tikka", amount: "₹280" },
  { qty: 4, name: "Butter naan", amount: "₹200" },
  { qty: 1, name: "Dal makhani", amount: "₹240" },
  { qty: 2, name: "Sweet lassi", amount: "₹160" },
];

function RestaurantArt() {
  return (
    <div className="wl-mock wl-mock-split">
      <div className="wl-mock-col">
        <div className="wl-mock-tags wl-in" style={{ "--i": 0 }}>
          <span className="wl-mock-tag">Dine-in</span>
          <span className="wl-mock-tag is-soft">4 guests</span>
        </div>
        <ul className="wl-mock-lines">
          {RESTAURANT_LINES.map((line, index) => (
            <li key={line.name} className="wl-in" style={{ "--i": index + 1 }}>
              <span className="wl-mock-qty">{line.qty}×</span>
              <span className="wl-mock-name">{line.name}</span>
              <span className="wl-mock-amount">{line.amount}</span>
            </li>
          ))}
        </ul>
        <p className="wl-mock-banner is-kitchen wl-in" style={{ "--i": 5 }}>
          <Icon name="chef" size={15} /> KOT sent to the kitchen
        </p>
      </div>
      <div className="wl-mock-col">
        <div className="wl-mock-bill wl-in" style={{ "--i": 6 }}>
          <p className="wl-mock-bill-title">Bill</p>
          <dl className="wl-mock-sums">
            <div><dt>Subtotal</dt><dd>₹880.00</dd></div>
            <div><dt>CGST 2.5%</dt><dd>₹22.00</dd></div>
            <div><dt>SGST 2.5%</dt><dd>₹22.00</dd></div>
            <div className="is-total"><dt>Total</dt><dd>₹924.00</dd></div>
          </dl>
        </div>
        <p className="wl-mock-paid wl-pop" style={{ "--i": 8 }}>
          <Icon name="check-circle" size={16} /> Paid by UPI
        </p>
      </div>
    </div>
  );
}

const KIRANA_LINES = [
  { name: "Wheat atta 5 kg", note: "Barcode", amount: "₹265" },
  { name: "Toor dal 1 kg", note: "Barcode", amount: "₹160" },
  { name: "Sunflower oil 1 L", note: "Barcode", amount: "₹155" },
  { name: "Onion 1.250 kg", note: "Scale label", amount: "₹50" },
];

function KiranaArt() {
  return (
    <div className="wl-mock">
      <div className="wl-mock-scan wl-in" style={{ "--i": 0 }}>
        <span className="wl-mock-barcode" />
        <span>Scan a barcode or a scale label</span>
        <span className="wl-mock-laser" />
      </div>
      <div className="wl-mock-split">
        <ul className="wl-mock-lines">
          {KIRANA_LINES.map((line, index) => (
            <li key={line.name} className="wl-in is-scanned" style={{ "--i": index + 1 }}>
              <span className="wl-mock-name">
                {line.name}
                <small>{line.note}</small>
              </span>
              <span className="wl-mock-amount">{line.amount}</span>
            </li>
          ))}
        </ul>
        <div className="wl-mock-col">
          <div className="wl-mock-bill wl-in" style={{ "--i": 5 }}>
            <p className="wl-mock-bill-title">4 items</p>
            <p className="wl-mock-big">₹630.00</p>
            <p className="wl-mock-fine">Prices include GST</p>
          </div>
          <div className="wl-mock-pay wl-in" style={{ "--i": 6 }}>
            <span>Cash</span>
            <span className="is-chosen">UPI</span>
            <span>Udhaar</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const STYLISTS = ["Asha", "Ravi", "Meena"];
const SLOTS = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"];
// Each booking: its stylist's column, its first and last half-hour, and its tone.
const BOOKINGS = [
  { name: "Haircut", column: 1, from: 1, to: 2, tone: "teal" },
  { name: "Hair spa", column: 1, from: 3, to: 5, tone: "violet" },
  { name: "Beard trim", column: 2, from: 2, to: 3, tone: "amber" },
  { name: "Facial", column: 2, from: 4, to: 6, tone: "rose" },
  { name: "Bridal make-up", column: 3, from: 1, to: 5, tone: "cyan" },
  { name: "Manicure", column: 3, from: 5, to: 6, tone: "green" },
];

function SalonArt() {
  return (
    <div className="wl-mock">
      <div className="wl-cal">
        <span className="wl-cal-corner" />
        {STYLISTS.map((name, index) => (
          <span key={name} className="wl-cal-who" style={{ gridColumn: index + 2 }}>
            <span className="wl-cal-avatar">{name[0]}</span>
            {name}
          </span>
        ))}
        {SLOTS.map((slot, index) => (
          <span key={slot} className="wl-cal-time" style={{ gridRow: index + 2 }}>{slot}</span>
        ))}
        {BOOKINGS.map((booking, index) => (
          <span
            key={booking.name}
            className={`wl-cal-booking is-${booking.tone} wl-in`}
            style={{ gridColumn: booking.column + 1, gridRow: `${booking.from + 1} / ${booking.to + 1}`, "--i": index }}
          >
            {booking.name}
          </span>
        ))}
        <span className="wl-cal-now" />
      </div>
    </div>
  );
}

const QUEUE = [
  { token: "15", doctor: "Dr Rao", state: "Waiting", tone: "" },
  { token: "16", doctor: "Dr Iyer", state: "Vitals done", tone: "is-ready" },
  { token: "17", doctor: "Dr Rao", state: "Waiting", tone: "" },
  { token: "18", doctor: "Dr Iyer", state: "Booked · 11:30", tone: "is-later" },
];

function ClinicArt() {
  return (
    <div className="wl-mock wl-mock-split">
      <div className="wl-mock-col">
        <div className="wl-mock-now wl-in" style={{ "--i": 0 }}>
          <p className="wl-mock-bill-title">Now seeing</p>
          <p className="wl-mock-token">14</p>
          <p className="wl-mock-fine">Dr Rao · Room 2</p>
        </div>
        <p className="wl-mock-banner is-lab wl-in" style={{ "--i": 5 }}>
          <span className="wl-mock-barcode is-small" /> Sample barcoded for the lab
        </p>
      </div>
      <ul className="wl-mock-lines wl-mock-queue">
        {QUEUE.map((row, index) => (
          <li key={row.token} className={`wl-in ${row.tone}`.trim()} style={{ "--i": index + 1 }}>
            <span className="wl-mock-chip">{row.token}</span>
            <span className="wl-mock-name">{row.doctor}</span>
            <span className="wl-mock-state">{row.state}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ART = { restaurant: RestaurantArt, grocery: KiranaArt, salon: SalonArt, healthcare: ClinicArt };

// The screen for a scene's business type, or nothing for a type with no drawing.
export default function SceneArt({ type }) {
  const Art = ART[type];
  return Art ? <Art /> : null;
}
