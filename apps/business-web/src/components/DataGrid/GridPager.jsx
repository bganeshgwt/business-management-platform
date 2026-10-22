import Icon from "@bmp/ui/Icon";
import { count } from "@bmp/shared/format";

// The paging bar under a grid: where you are ("26–50 of 312"), how many rows
// a page holds, and first / previous / page / next / last. Every control is a
// real button or select, so it is reachable and usable from the keyboard.
//
// A list that fits on one page still says how many rows it holds, but shows
// no buttons that could only ever be disabled.

const Edge = ({ end }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {end === "first" ? (
      <>
        <path d="M17 18l-6-6 6-6" />
        <path d="M7 6v12" />
      </>
    ) : (
      <>
        <path d="M7 18l6-6-6-6" />
        <path d="M17 6v12" />
      </>
    )}
  </svg>
);

// A page picker longer than this would be a scroll wheel, not a shortcut.
const MAX_PAGE_CHOICES = 400;

export default function GridPager({ page, pageCount, pageSize, sizes, total, onPage, onPageSize, controls, label }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const first = page <= 1;
  const last = page >= pageCount;

  return (
    <nav className="dg-pager" aria-label={`${label} pages`}>
      <p className="dg-pager-range">
        {controls ? (
          <>
            <strong>
              {count(from)}–{count(to)}
            </strong>{" "}
            of <strong>{count(total)}</strong>
          </>
        ) : (
          <>
            Showing all <strong>{count(total)}</strong>
          </>
        )}
      </p>

      {controls && (
        <>
          <label className="dg-pager-size">
            <span>Rows per page</span>
            <select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
              {sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <div className="dg-pager-nav">
            <button type="button" className="dg-pager-button" onClick={() => onPage(1)} disabled={first} aria-label="First page" title="First page">
              <Edge end="first" />
            </button>
            <button type="button" className="dg-pager-button is-step" onClick={() => onPage(page - 1)} disabled={first} aria-label="Previous page">
              <Icon name="chevron-left" size={16} strokeWidth={2.25} />
              <span className="dg-pager-word" aria-hidden="true">
                Previous
              </span>
            </button>
            {pageCount <= MAX_PAGE_CHOICES ? (
              <label className="dg-pager-page">
                <span>Page</span>
                <select value={page} onChange={(event) => onPage(Number(event.target.value))} aria-label={`Page, of ${pageCount}`}>
                  {Array.from({ length: pageCount }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {index + 1}
                    </option>
                  ))}
                </select>
                <span>of {count(pageCount)}</span>
              </label>
            ) : (
              <span className="dg-pager-page">
                Page <strong>{count(page)}</strong> of {count(pageCount)}
              </span>
            )}
            <button type="button" className="dg-pager-button is-step" onClick={() => onPage(page + 1)} disabled={last} aria-label="Next page">
              <span className="dg-pager-word" aria-hidden="true">
                Next
              </span>
              <Icon name="chevron-right" size={16} strokeWidth={2.25} />
            </button>
            <button type="button" className="dg-pager-button" onClick={() => onPage(pageCount)} disabled={last} aria-label="Last page" title="Last page">
              <Edge end="last" />
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
