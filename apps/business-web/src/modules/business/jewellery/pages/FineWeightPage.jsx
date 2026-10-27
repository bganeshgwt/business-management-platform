import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, dateTime, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { ALL_PURITIES, finenessOf, grams, readTags, splitPurity } from "./jewellery";
import "../styles/jewellery.css";

// The fine-weight book: each purity's metal in grams and in fine (pure)
// grams wherever it is (pieces in stock, on approval, at karigars and at the
// hallmarking centre; the shop's own metal; metal with karigars), what it
// held at the start of a period, every movement that changed it (tagged in,
// sold, old gold, metal with suppliers, the karigars' wastage …), the moves
// inside the shop that leave it as it was, and what it holds at the end. A
// count weighs a location's metal and scans its pieces, purity by purity, and
// is held against the book: the tags not found, those found that the book
// has elsewhere, and the difference in fine weight.

const signed = (value) => `${Number(value) > 0 ? "+" : ""}${grams(value)}`;

function CountForm({ biz, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""));
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState(() => [{ key: newKey(), purity: "gold:22K", tags: "", metal: "", fineness: "" }]);
  const setRow = (key, change) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const submit = () => businessWrite(biz.id, "jewellery/fine-weight/counts", { requestKey, locationId, notes: notes.trim() || undefined,
    purities: rows.map((r) => ({ ...splitPurity(r.purity), tags: readTags(r.tags), ...(r.metal !== "" ? { metalWeight: r.metal, ...(r.fineness !== "" ? { metalFineness: r.fineness } : {}) } : {}) })) });
  return (
    <FormDialog title="Count against the book" icon="scale" width={820} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Hold it against the book" successMessage="Counted."
      description="Scan the tags of the pieces in stock at the location and weigh its metal, purity by purity. Nothing is changed by a count: it shows what differs.">
      {locations.length > 1 && <Field label="Location"><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <div className="field-wide jw-og-lines">
        {rows.map((r, index) => {
          const { metal, purity } = splitPurity(r.purity);
          return (
            <fieldset key={r.key} className="jw-og-line">
              <legend>Purity {index + 1}</legend>
              <div className="jw-row">
                <Field label="Purity"><select value={r.purity} onChange={(e) => setRow(r.key, { purity: e.target.value })}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
                <Field label="Its metal weighed (g, optional)"><input type="number" min="0" step="0.001" value={r.metal} onChange={(e) => setRow(r.key, { metal: e.target.value })} /></Field>
                <Field label="Fineness"><input type="number" min="0.1" max="999.9" step="0.1" value={r.fineness} placeholder={String(finenessOf(metal, purity))} onChange={(e) => setRow(r.key, { fineness: e.target.value })} /></Field>
                {rows.length > 1 && <button type="button" className="link-button danger" onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>Remove</button>}
              </div>
              <Field label="Tags found" wide hint="Scan each piece's tag, with spaces or new lines between them."><textarea rows={3} className="mono" value={r.tags} onChange={(e) => setRow(r.key, { tags: e.target.value })} /></Field>
            </fieldset>
          );
        })}
        <button type="button" className="chip-button" onClick={() => setRows((all) => [...all, { key: newKey(), purity: "gold:18K", tags: "", metal: "", fineness: "" }])}><Icon name="plus" size={13} /> Another purity</button>
      </div>
      <Field label="Notes (optional)" wide><input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormDialog>
  );
}

function CountCard({ count }) {
  return (
    <SectionCard icon="scale" title={`Count at ${count.location_name}`} description={`${dateTime(count.created_at)} · ${count.by_name}${count.notes ? ` · ${count.notes}` : ""}`}>
      <table className="jw-rates">
        <thead><tr><th scope="col">Purity</th><th scope="col">Pieces: book · counted</th><th scope="col">Fine in pieces: difference</th><th scope="col">Not found</th><th scope="col">Found, not in stock here</th><th scope="col">Metal: book · weighed (fine)</th></tr></thead>
        <tbody>{count.lines.map((l) => (
          <tr key={`${l.metal}:${l.purity}`}><th scope="row">{l.mark}</th><td>{l.book_pieces} · {l.counted_pieces}</td><td className={Number(l.pieces_difference) ? "bz-due" : ""}>{signed(l.pieces_difference)}</td>
            <td className="mono">{l.missing_tags.join(" ") || "—"}</td><td className="mono">{l.extra_tags.join(" ") || "—"}</td>
            <td>{grams(l.book_metal_fine)} · {l.counted_metal_fine === null ? "not weighed" : grams(l.counted_metal_fine)}{l.metal_difference !== null && Number(l.metal_difference) ? <span className="bz-due"> ({signed(l.metal_difference)})</span> : null}</td></tr>
        ))}</tbody>
      </table>
    </SectionCard>
  );
}

export default function FineWeightPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [period, setPeriod] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [book, setBook] = useState(null);
  const [error, setError] = useState("");
  const [counting, setCounting] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/fine-weight", period, controller.signal).then((b) => { setBook(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, period, version]);
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title="Fine weight"
        description="Each purity's metal in grams and fine grams wherever it is, with every movement that changed it, held against what is counted."
        primary={biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => setCounting(true)}><Icon name="scale" size={16} /> Count against the book</button>}
        secondary={<span className="jw-row">
          <Field label="From"><input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, from: e.target.value }))} /></Field>
          <Field label="To"><input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, to: e.target.value }))} /></Field>
        </span>} />
      <ErrorMessage message={error} />
      {!book ? !error && <Loading /> : book.purities.length === 0 ? <SectionCard><p className="jw-note">Nothing is in the book yet: pieces tagged and metal taken in appear here.</p></SectionCard> : (
        book.purities.map((p) => (
          <SectionCard key={`${p.metal}:${p.purity}`} icon="scale" title={p.label}
            description={`${dateShort(book.from, { year: true })} to ${dateShort(book.to, { year: true })}: ${grams(p.opening.fine)} fine at the start, ${grams(p.closing.fine)} at the end.`}>
            <div className="jw-row jw-book">
              <table className="jw-rates jw-grow">
                <caption className="sr-only">{p.label}: the book</caption>
                <thead><tr><th scope="col">The book</th><th scope="col">Metal</th><th scope="col">Fine</th></tr></thead>
                <tbody>
                  <tr><th scope="row">At the start</th><td>{grams(p.opening.net)}</td><td>{grams(p.opening.fine)}</td></tr>
                  {p.movements.map((m) => <tr key={m.kind}><th scope="row">{m.words}</th><td>{signed(m.net)}</td><td>{signed(m.fine)}</td></tr>)}
                  <tr className="jw-total"><th scope="row">At the end</th><td>{grams(p.closing.net)}</td><td>{grams(p.closing.fine)}</td></tr>
                </tbody>
              </table>
              <table className="jw-rates jw-grow">
                <caption className="sr-only">{p.label}: where it is</caption>
                <thead><tr><th scope="col">Where it is</th><th scope="col">Metal</th><th scope="col">Fine</th></tr></thead>
                <tbody>{p.holders.filter((h) => Number(h.net) || Number(h.fine)).map((h) => <tr key={h.holder}><th scope="row">{h.words}</th><td>{grams(h.net)}</td><td>{grams(h.fine)}</td></tr>)}</tbody>
              </table>
            </div>
            {p.within.length > 0 && (
              <details className="jw-within">
                <summary>Moves inside the shop ({p.within.length}): they leave the total as it was</summary>
                <ul className="jw-history">{p.within.map((m) => (
                  <li key={m.kind}><span>{m.words}: {grams(m.moved.net)} ({grams(m.moved.fine)} fine)</span>
                    <span>{m.moves.length ? m.moves.map((x) => `${x.words} ${signed(x.net)}`).join(" · ") : "Within the pieces in stock"}</span></li>
                ))}</ul>
              </details>
            )}
          </SectionCard>
        ))
      )}
      {book?.counts.map((count) => <CountCard key={count.id} count={count} />)}
      {counting && <CountForm biz={biz} onClose={() => setCounting(false)} onSaved={() => { setCounting(false); setVersion((n) => n + 1); }} />}
    </div>
  );
}
