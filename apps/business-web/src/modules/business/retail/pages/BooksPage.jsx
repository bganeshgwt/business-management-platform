import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import "../styles/business-retail.css";

// Book details: ISBN, author, publisher, edition, language and year, kept as
// searchable fields (search finds a book by any of them, or by its ISBN
// scanned at the counter). A book's ISBN-13 is also its barcode.

const SHOW = [["", "All items"], ["true", "Books"], ["false", "Stationery & other items"]];

export default function BooksPage() {
  const biz = useOpenBusiness();
  const [details, setDetails] = useState("");
  const list = useServerList("books", { gridId: "retail-books", params: details ? { details } : {} });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");

  const columns = useMemo(() => [
    { key: "label", header: "Title / item", value: (b) => b.label, mobile: "title", pin: true,
      render: (b) => <span className="bz-two-line"><strong>{b.label}</strong><small className="muted">{[b.author, b.edition].filter(Boolean).join(" · ") || b.category || ""}</small></span> },
    { key: "author", header: "Author", value: (b) => b.author || "", mobile: "subtitle" },
    { key: "publisher", header: "Publisher", value: (b) => b.publisher || "" },
    // The ISBN is the barcode (pro pass C-24): a sticker that says otherwise is pointed out.
    { key: "isbn", header: "ISBN", value: (b) => b.isbn || "", className: "mono", mobile: "show",
      render: (b) => (b.isbn && b.barcode && b.barcode !== b.isbn
        ? <span className="bz-two-line"><span>{b.isbn}</span><small className="rt-warn-text" title={`Labels print ${b.barcode}`}>Barcode {b.barcode} differs</small></span>
        : b.isbn || <span className="muted">—</span>) },
    { key: "barcode", header: "Barcode", value: (b) => b.barcode || "", className: "mono", defaultHidden: true },
    { key: "edition", header: "Edition", value: (b) => b.edition || "", defaultHidden: true },
    { key: "language", header: "Language", value: (b) => b.language || "", defaultHidden: true },
    { key: "published_year", header: "Year", value: (b) => b.published_year || "", defaultHidden: true },
    { key: "category", header: "Category", value: (b) => b.category || "" },
    { key: "price", header: "Price", type: "money", exact: true, value: (b) => Number(b.price), mobile: "show" },
    { key: "stock", header: "In stock", type: "number", value: (b) => Number(b.stock), render: (b) => quantity(b.stock, b.unit) },
    { key: "active", header: "Status", type: "status", value: (b) => (b.active ? "active" : "inactive"), render: (b) => <ActiveBadge active={b.active} />, defaultHidden: true },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions",
      render: (b) => <button type="button" className="chip-button" onClick={() => setEditing(b)}>{b.has_details ? "Edit details" : "Add book details"}</button> },
  ].filter(Boolean), [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="book" title="Book details"
        description="Find any book by title, author, publisher or ISBN. Scanning a book's ISBN at the Quick bill finds it straight away."
        actions={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a book</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="book" title="Books and stationery">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Title, author, publisher or ISBN" }} caption="Books" columns={columns} currency={biz.symbol}
          toolbar={(
            <div className="segmented" role="group" aria-label="Which items">
              {SHOW.map(([key, label]) => <button key={key || "all"} type="button" className={`segment ${details === key ? "is-active" : ""}`} aria-pressed={details === key} onClick={() => setDetails(key)}>{label}</button>)}
            </div>
          )}
          rowNoun={["item", "items"]} exportName={biz.can("catalog.export") ? `${biz.business.code}-books` : undefined}
          rowClassName={(b) => (!b.active ? "dg-tone-muted" : "")}
          empty="No books found" emptyHint="Try another word, or add a book." emptyIcon="book" />
      </SectionCard>
      {editing && <BookDialog book={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); setNotice(`${editing.label || "The book"} saved.`); list.reload(); }} />}
    </div>
  );
}

function BookDialog({ book, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const adding = !book.id;
  const { options, error } = useOptions(adding ? ["tax-rates?active=true", "categories?active=true"] : []);
  const slabs = options?.["tax-rates?active=true"] || [];
  const categories = options?.["categories?active=true"] || [];
  const nil = slabs.find((t) => Number(t.rate) === 0);
  const [form, setForm] = useState({
    name: "", code: "", price: "", taxRateId: "", categoryId: "",
    isbn: book.isbn || "", author: book.author || "", publisher: book.publisher || "", edition: book.edition || "", language: book.language || "", publishedYear: book.published_year ? String(book.published_year) : "",
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const details = { isbn: form.isbn, author: form.author, publisher: form.publisher, edition: form.edition, language: form.language, publishedYear: form.publishedYear };
  const submit = () => (adding
    ? businessWrite(biz.id, "books", { ...details, name: form.name, code: form.code, price: form.price, taxRateId: form.taxRateId || nil?.id, categoryId: form.categoryId || undefined })
    : businessWrite(biz.id, `books/${book.id}`, details, "put"));
  return (
    <FormDialog title={adding ? "Add a book" : `Book details · ${book.label}`} icon="book" width={720} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={adding && !options}
      description={adding ? "The ISBN becomes the barcode, so the book scans at the counter. Printed books are usually GST nil." : "The ISBN is checked: a mistyped digit is caught."}>
      <FormError message={error} />
      {adding && !options && !error && <div className="field-wide"><Loading /></div>}
      {adding && (
        <>
          <Field label="Title" wide><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          <Field label="SKU code"><input required maxLength={60} className="mono" value={form.code} onChange={set("code")} placeholder="e.g. BK-GODAAN" /></Field>
          <Field label={biz.settings.tax_mode === "inclusive" ? "Price (including GST)" : "Price (before GST)"}><input required type="number" min="0" step="0.01" value={form.price} onChange={set("price")} /></Field>
          <Field label="GST slab">
            <select value={form.taxRateId || String(nil?.id || "")} onChange={set("taxRateId")}>{slabs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </Field>
          <Field label="Category">
            <select value={form.categoryId} onChange={set("categoryId")}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}</select>
          </Field>
        </>
      )}
      <Field label="ISBN" hint="10 or 13 digits; hyphens are fine."><input maxLength={20} className="mono" value={form.isbn} onChange={set("isbn")} placeholder="978-…" /></Field>
      <Field label="Author"><input maxLength={200} value={form.author} onChange={set("author")} /></Field>
      <Field label="Publisher"><input maxLength={150} value={form.publisher} onChange={set("publisher")} /></Field>
      <Field label="Edition"><input maxLength={60} value={form.edition} onChange={set("edition")} placeholder="e.g. 3rd, 2024 reprint" /></Field>
      <Field label="Language"><input maxLength={40} value={form.language} onChange={set("language")} placeholder="e.g. English, Hindi" /></Field>
      <Field label="Year published"><input type="number" min="1450" max="2200" step="1" value={form.publishedYear} onChange={set("publishedYear")} /></Field>
    </FormDialog>
  );
}
