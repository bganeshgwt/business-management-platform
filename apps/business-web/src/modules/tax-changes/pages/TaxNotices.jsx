import Icon from "@bmp/ui/Icon";
import { NOTICE_RULE, noticeText } from "../taxChanges";
import "../styles/tax-changes.css";

// What a GST rate change still to come does to an open quotation or sales
// order: which of its items move, from when, and how each is billed after.
// Nothing on the document itself changes. `notices`: the server's
// tax_notices, [{ startsOn, from, to, toName, items }].
export default function TaxNotices({ notices }) {
  if (!notices?.length) return null;
  return (
    <div className="txc-notices" role="status">
      {notices.map((notice) => (
        <p key={`${notice.startsOn}-${notice.from}-${notice.to}`} className="bz-note-card is-warning small">
          <Icon name="percent" size={15} /> {noticeText(notice)} {NOTICE_RULE}
        </p>
      ))}
    </div>
  );
}

// The open quotations and sales orders that hold items a change moves (a
// shop's): each shows the notice above until the date. `documents`: the
// server's [{ kind, id, number, customer, items }].
export function OpenDocuments({ documents, words }) {
  if (!documents?.length) return null;
  const quotations = documents.filter((d) => d.kind === "quotation").length;
  const orders = documents.length - quotations;
  return (
    <section className="txc-documents" aria-label="Open quotations and sales orders">
      <p className="small">
        <strong>{[quotations && `${quotations} open ${quotations === 1 ? "quotation" : "quotations"}`, orders && `${orders} open sales ${orders === 1 ? "order" : "orders"}`].filter(Boolean).join(" and ")}</strong>{" "}
        hold {words.items} that move. Each says so until the date. {NOTICE_RULE}
      </p>
      <ul className="txc-document-list small">
        {documents.map((d) => (
          <li key={`${d.kind}-${d.id}`}>
            <span className="mono">{d.number}</span> · {d.customer} · <span className="muted">{d.items.join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
