// A column heading that sorts. Clicking the one already sorted turns it round.
//
// It lived inside the stock list until the reports needed the same thing; a
// second copy would have been a second set of arrow rules to keep in step.
export default function SortHeader({ label, field, sort, onSort, right }) {
  const active = sort.key === field;

  return (
    <th
      className={right ? "right" : ""}
      aria-sort={active ? (sort.ascending ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={`sort-header ${active ? "is-active" : ""}`}
        onClick={() => onSort({ key: field, ascending: active ? !sort.ascending : true })}
      >
        {label}
        <span className="sort-caret" aria-hidden="true">
          {active ? (sort.ascending ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}
