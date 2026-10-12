import { REPORT_RANGES, matchingReportRange } from "./reportFormat";

// From and To, with the ranges worth one click — including Yesterday (read
// every morning) and Last month (what GST is filed for). The range in force is
// marked; typing dates by hand clears the mark, because a typed range is none
// of them.
//
// A start typed after the end moves the end with it (and an end typed before
// the start moves the start), rather than asking the server for a range that
// runs backwards and showing its refusal.
export default function ReportRange({ from, to, anchor, onChange }) {
  const active = matchingReportRange(from, to, anchor);

  const pickFrom = (value) => value && onChange({ from: value, to: to && value > to ? value : to });
  const pickTo = (value) => value && onChange({ from: from && value < from ? value : from, to: value });

  return (
    <div className="report-range">
      <label className="field">
        <span>From</span>
        <input
          type="date"
          value={from}
          onChange={(event) => pickFrom(event.target.value)}
        />
      </label>

      <label className="field">
        <span>To</span>
        <input
          type="date"
          value={to}
          onChange={(event) => pickTo(event.target.value)}
        />
      </label>

      <div className="field report-quick">
        <span>Quick pick</span>
        <div className="segmented" role="radiogroup" aria-label="Quick date range">
          {REPORT_RANGES.map((option) => (
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
    </div>
  );
}
