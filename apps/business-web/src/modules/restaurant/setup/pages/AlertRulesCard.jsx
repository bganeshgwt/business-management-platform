import SectionCard from "../../../../components/SectionCard";
import FormField from "../../../../components/FormField";

// Settings -> Alerts and timings: the restaurant's own lines for the bell,
// the boards and the lists (migration 1791640001000). Each field says what
// it does and the number it starts at, so an owner can always put a rule
// back. Saved with the rest of the settings form.
//
// The ranges match the API's (ruleSettings.service), so the browser stops a
// typo before the server has to.

// Notes an Indian drawer may hold. A list saved with another value (set
// through the API) still shows it, ticked.
const COMMON_NOTES = [2000, 500, 200, 100, 50, 20, 10, 5];

const SLOT_CHOICES = [10, 15, 20, 30, 45, 60];

// One group per area. `unit` follows the number in the hint; `money` fields
// show the currency symbol instead.
const GROUPS = [
  {
    title: "Theft control",
    note: "What the bell flags for owners and managers, and where the theft report draws its line.",
    fields: [
      { key: "alertLargeDiscountPercent", label: "Large discount from (% of the bill)", min: 1, max: 100, fallback: 20, hint: "A discount this big is listed in the bell and the theft report." },
      { key: "alertLargeDiscountAmount", label: "…or from (amount)", min: 1, max: 10000000, money: true, fallback: 1000, hint: "Any discount this large is flagged, whatever the bill." },
      { key: "alertHugeDiscountPercent", label: "Warning discount from (% of the bill)", min: 1, max: 100, fallback: 50, hint: "Past this the alert is a warning, not just worth knowing." },
      { key: "alertReprintCount", label: "Reprint alert at (prints)", min: 2, max: 20, fallback: 3, unit: "prints", hint: "A bill printed this many times is flagged. One reprint is a guest asking for a copy." },
      { key: "alertCashShortCritical", label: "Cash short is critical from (amount)", min: 1, max: 10000000, money: true, fallback: 1000, hint: "A day closed this much short rings as critical. It warns from the cash difference limit set under Business day → Cash rules." },
    ],
  },
  {
    title: "Kitchen and deliveries",
    note: "The kitchen's own timers, and the time food may wait at the pass, are set on Kitchen display → Stations & routing.",
    fields: [
      { key: "deliverySlaMinutes", label: "Delivery promise (minutes)", min: 10, max: 240, fallback: 45, unit: "min", hint: "Door to door. Past this a delivery is late on the board, the bell and the report." },
      { key: "deliveryWarnMinutes", label: "Delivery turns amber after (minutes)", min: 5, max: 235, fallback: 30, unit: "min", hint: "Still on time, but only if it leaves now. Must come before the promise." },
      { key: "deliveryReadyWaitMinutes", label: "Packed and waiting for a rider (minutes)", min: 1, max: 120, fallback: 10, unit: "min", hint: "Food packed this long with no rider is going cold." },
      { key: "deliveryOutWarnMinutes", label: "Out for delivery, warn after (minutes)", min: 5, max: 240, fallback: 45, unit: "min", hint: "A run this long is worth a look." },
      { key: "deliveryOutCriticalMinutes", label: "Out for delivery, critical after (minutes)", min: 10, max: 480, fallback: 60, unit: "min", hint: "Past this, someone should phone the rider. Must be after the warning." },
    ],
  },
  {
    title: "Reservations",
    fields: [
      { key: "reservationLateMinutes", label: "Booking is late after (minutes)", min: 1, max: 180, fallback: 15, unit: "min", hint: "Past their time by this much, the host stand and the bell say so." },
      { key: "reservationLastSeatingMinutes", label: "Last seating before closing (minutes)", min: 0, max: 240, fallback: 30, unit: "min", hint: "No booking, by staff or online, starts closer to closing than this." },
      { key: "reservationSlotMinutes", label: "Online booking times every", choices: SLOT_CHOICES, fallback: 30, unit: "min", hint: "The step between the times the online booking page offers." },
    ],
  },
  {
    title: "Time clock",
    note: "Five wrong PINs lock a person's PIN for 15 minutes. That guard against guessing stays fixed.",
    fields: [
      { key: "timeclockLateMinutes", label: "Not clocked in, alert after (minutes)", min: 1, max: 240, fallback: 15, unit: "min", hint: "Someone rostered and not in this long after their shift began is flagged." },
      { key: "timeclockLongBreakMinutes", label: "Long break after (minutes)", min: 5, max: 480, fallback: 45, unit: "min", hint: "Or the shift's own break, where a shift allows longer." },
      { key: "timeclockOvertimeMinutes", label: "Overtime counts from (minutes past the shift)", min: 0, max: 240, fallback: 15, unit: "min", hint: "Staying on less than this is not overtime; from it, all of it counts." },
      { key: "timeclockEarlyMinutes", label: "Clock opens before the shift (minutes)", min: 0, max: 720, fallback: 60, unit: "min", hint: "Earlier than this the kiosk will not clock someone in. A manager can still add the punch." },
    ],
  },
  {
    title: "Guests",
    note: "Guest insights' lists and the guest book's Lapsed view.",
    fields: [
      { key: "guestRegularVisits", label: "Regular: at least (visits)", min: 2, max: 50, fallback: 3, unit: "visits", hint: "Visits it takes to be a regular…" },
      { key: "guestRegularDays", label: "Regular: within (days)", min: 7, max: 730, fallback: 60, unit: "days", hint: "…inside this many days." },
      { key: "guestLapsedDays", label: "Lapsed after (days without a visit)", min: 7, max: 730, fallback: 45, unit: "days", hint: "A guest who came at least twice and not for this long. The guest book's Lapsed view uses it too." },
      { key: "guestNewDays", label: "New guest for (days)", min: 1, max: 365, fallback: 30, unit: "days", hint: "A first visit this recent puts a guest on the New guests list." },
      { key: "guestBigSpenderPercent", label: "Big spenders: the top (%)", min: 1, max: 50, fallback: 10, unit: "%", hint: "This share of guests, by lifetime spend." },
    ],
  },
  {
    title: "Reorder plan",
    fields: [
      { key: "reorderLookbackDays", label: "Read usage over (days)", min: 3, max: 90, fallback: 14, unit: "days", hint: "How far back “how fast does it go” looks." },
      { key: "reorderSafetyDays", label: "Safety stock (days)", min: 0, max: 30, fallback: 2, unit: "days", hint: "A cushion on top of the days covered, for a late delivery." },
      { key: "reorderHorizonDays", label: "Plan covers (days)", min: 1, max: 30, fallback: 7, unit: "days", hint: "What the reorder screen and the bell plan for until someone picks another." },
    ],
  },
];

const startsAt = (field, currency) =>
  field.money ? `${currency}${field.fallback.toLocaleString("en-IN")}` : `${field.fallback}${field.unit ? ` ${field.unit}` : ""}`;

export default function AlertRulesCard({ rules, onChange, canEdit, currency = "₹" }) {
  const set = (key, value) => onChange({ ...rules, [key]: value });
  const notes = rules.cashDenominations || [];
  const noteChoices = [...new Set([...COMMON_NOTES, ...notes])].sort((a, b) => b - a);

  const toggleNote = (note) => {
    const next = notes.includes(note) ? notes.filter((one) => one !== note) : [...notes, note];
    // At least one note: coins alone are not a count by notes.
    if (next.length > 0) {
      set("cashDenominations", next.sort((a, b) => b - a));
    }
  };

  return (
    <SectionCard
      id="settings-alerts"
      icon="bell"
      tone="warning"
      title="Alerts and timings"
      description="Where the bell, the boards and the guest and stock lists draw their lines. Each starts at the number shown in its note."
    >
      {GROUPS.map((group) => (
        <fieldset key={group.title} className="settings-rule-group">
          <legend className="invoice-series-title">{group.title}</legend>
          {group.note && <p className="small muted settings-rule-note">{group.note}</p>}
          <div className="form-grid">
            {group.fields.map((field) => (
              <FormField
                key={field.key}
                label={field.label}
                hint={`${field.hint} Starts at ${startsAt(field, currency)}.`}
              >
                {field.choices ? (
                  <select
                    value={rules[field.key] ?? field.fallback}
                    onChange={(event) => set(field.key, Number(event.target.value))}
                    disabled={!canEdit}
                  >
                    {field.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice} minutes
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.money ? "0.01" : "1"}
                    value={rules[field.key] ?? ""}
                    onChange={(event) => set(field.key, event.target.value)}
                    required
                    disabled={!canEdit}
                  />
                )}
              </FormField>
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="settings-rule-group">
        <legend className="invoice-series-title">Cash count</legend>
        <p className="small muted settings-rule-note">
          The notes the closing and drawer counts list, largest first. Coins are always counted as one amount besides.
          Starts at {currency}500 down to {currency}10 ({currency}2,000 notes are out of circulation).
        </p>
        <div className="settings-note-choices" role="group" aria-label="Notes in the cash count">
          {noteChoices.map((note) => (
            <label key={note} className="checkbox">
              <input
                type="checkbox"
                checked={notes.includes(note)}
                onChange={() => toggleNote(note)}
                disabled={!canEdit || (notes.length === 1 && notes.includes(note))}
              />
              <span>
                {currency}
                {note.toLocaleString("en-IN")}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </SectionCard>
  );
}
