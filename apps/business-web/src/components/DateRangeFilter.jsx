import { QUICK_RANGES, matchingRange } from "@bmp/shared/dates";

// From and To, with the handful of ranges worth one click.
//
// These used to be three underlined links that gave no sign of which one was
// in force — you could read "Last 7 days" while looking at a month of figures
// and have no way to tell. They are now a segmented control: the range in
// force is marked, and picking dates by hand simply clears the mark, because
// a typed range genuinely is none of them.
export default function DateRangeFilter({
  from,
  to,
  onChange,
  label = "date range",
  // The date this screen should call "today" — the open business day, where
  // the screen knows it. Without one, the calendar date.
  anchor,
}) {
  const active = matchingRange(from, to, anchor);

  return (
    <>
      <label className="field">
        <span>From</span>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => onChange({ from: event.target.value, to })}
        />
      </label>

      <label className="field">
        <span>To</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => onChange({ from, to: event.target.value })}
        />
      </label>

      <div className="field">
        <span>Quick pick</span>
        {/* A radio group rather than a row of buttons: exactly one range is in
            force at a time, and that is what a screen reader should hear. */}
        <div className="segmented" role="radiogroup" aria-label={`Quick ${label}`}>
          {QUICK_RANGES.map((option) => (
            <button
              type="button"
              key={option.key}
              className={`segment ${active === option.key ? "is-active" : ""}`}
              role="radio"
              aria-checked={active === option.key}
              onClick={() => onChange(option.range(anchor))}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
