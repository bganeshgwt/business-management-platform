// "Showing 100 of 111" — the line that stops a list quietly lying.
//
// Every list endpoint has a page size, and before this the extra rows simply
// were not there: a manager looking at 100 of 111 unpaid bills saw a complete
// looking table and no hint that eleven were missing. On a money screen that
// is the worst kind of wrong, because nothing on it looks wrong.
//
// It renders nothing at all when the list is whole, so a normal day is not
// cluttered by a notice about a limit nobody is near.
export default function TruncationNotice({ shown, total, what = "rows", hint }) {
  if (!total || total <= shown) {
    return null;
  }

  return (
    <p className="alert alert-notice" role="status">
      Showing the <strong>{shown}</strong> most recent of <strong>{total}</strong> {what}.{" "}
      {hint || "Narrow the filter to see the rest."}
    </p>
  );
}
