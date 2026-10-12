import Icon from "../../../../components/Icon";
import { count } from "../../../../services/format";

// "21–40 of 1,240", with Previous / Next and a page size.
//
// Every list on these screens is paged by the server and says how many there
// are in all, so a guest past the first page is one click away rather than
// silently missing.
export default function Pager({ total, limit, offset, onPage, onLimit, what = "rows", sizes = [25, 50, 100] }) {
  if (!total) {
    return null;
  }

  const first = offset + 1;
  const last = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <nav className="crm-pager" aria-label={`Pages of ${what}`}>
      <span className="muted small">
        <strong>
          {count(first)}–{count(last)}
        </strong>{" "}
        of <strong>{count(total)}</strong> {what}
      </span>

      <div className="crm-pager-controls">
        {onLimit && (
          <label className="crm-pager-size small muted">
            Show
            <select value={limit} onChange={(event) => onLimit(Number(event.target.value))}>
              {sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="button button-secondary button-sm crm-pager-button"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}
        >
          <Icon name="chevron-left" size={16} /> Previous
        </button>
        <span className="small muted nowrap">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="button button-secondary button-sm crm-pager-button"
          disabled={last >= total}
          onClick={() => onPage(offset + limit)}
        >
          Next <Icon name="chevron-right" size={16} />
        </button>
      </div>
    </nav>
  );
}
