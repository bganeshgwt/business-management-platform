import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { dateTime, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ALL_PURITIES, SESSION_WORDS, perGram, purityWords, ratesShareLink, sessionNow } from "./jewellery";
import "../styles/jewellery.css";

// Today's rates: for each purity the selling rate per gram and the rate the
// shop pays for old metal, as the latest rate sheet of the day sets them. A
// manager sets a new sheet (morning or evening; the shop's own, the
// association's or the IBJA rate typed in); a sheet is never changed, so a
// correction is a new sheet, and a bill takes the latest rate of its day.
// Below: every sheet, with the ones a later sheet of the same day replaced.

const SOURCE_WORDS = { shop: "Shop's own", association: "Association", ibja: "IBJA" };

export default function RatesPage() {
  const biz = useOpenBusiness();
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const canSet = biz.can("jewellery.approve");
  const history = useServerList("jewellery/rates", { gridId: "jewellery-rate-sheets", period: true });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/rates/today", undefined, controller.signal)
      .then((d) => { setBoard(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);

  // A new sheet starts from the rates in use today (or the last ones set), every purity listed.
  const openForm = () => {
    const known = new Map([...(board.previous || []), ...board.rates].map((r) => [`${r.metal}:${r.purity}`, r]));
    setForm({ requestKey: newKey(), session: sessionNow(), source: "association", note: "",
      rows: ALL_PURITIES.map((p) => ({ ...p, sell: known.get(p.key)?.sell_rate ? String(Number(known.get(p.key).sell_rate)) : "",
        buy: known.get(p.key)?.buy_rate ? String(Number(known.get(p.key).buy_rate)) : "" })) });
    setFormError("");
  };
  const setRow = (keyOf, change) => setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === keyOf ? { ...r, ...change } : r)) }));
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    const rates = form.rows.filter((r) => r.sell.trim()).map((r) => ({ metal: r.metal, purity: r.purity, sellRate: r.sell.trim(), ...(r.buy.trim() ? { buyRate: r.buy.trim() } : {}) }));
    if (!rates.length) return setFormError("Give the selling rate of at least one purity");
    setBusy(true);
    setFormError("");
    try {
      const next = await businessWrite(biz.id, "jewellery/rates", { requestKey: form.requestKey, session: form.session, source: form.source, note: form.note.trim() || undefined, rates });
      setBoard(next);
      setForm(null);
      history.reload();
      toast.success(`Rates set for ${rates.length} ${rates.length === 1 ? "purity" : "purities"}.`);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo(() => [
    { key: "created_at", header: "Set at", type: "datetime", value: (s) => s.created_at, mobile: "title" },
    { key: "session", header: "Session", value: (s) => SESSION_WORDS[s.session] || s.session,
      render: (s) => <span className="bz-two-line"><span>{SESSION_WORDS[s.session] || s.session}</span><small className="muted">{SOURCE_WORDS[s.source] || s.source}</small></span> },
    { key: "rates", header: "Rates per gram", value: (s) => (s.rates || []).map((r) => `${purityWords(r.metal, r.purity)} ${r.sell_rate}`).join(" "), mobile: "subtitle",
      render: (s) => <span className="jw-sheet-rates">{(s.rates || []).map((r) => <span key={`${r.metal}:${r.purity}`}><b>{purityWords(r.metal, r.purity)}</b> {perGram(biz, r.sell_rate)}{r.buy_rate ? <small className="muted"> · buys {perGram(biz, r.buy_rate)}</small> : null}</span>)}</span> },
    { key: "replaced", header: "In use", value: (s) => (s.replaced ? "Replaced" : "Latest of its day"),
      render: (s) => (s.replaced ? <span className="muted">Replaced later that day</span> : <span>Latest of {dateShort(s.rate_date, { year: true })}</span>) },
    { key: "set_by_name", header: "Set by", value: (s) => s.set_by_name },
    { key: "note", header: "Note", value: (s) => s.note || "", defaultHidden: true },
  ], [biz]);

  if (!board) return <div className="stack"><BusinessHeader icon="tag" title="Today's rates" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Today's rates"
        description={`Rates per gram for ${dateShort(board.day, { year: true })}, before making charges and GST. A bill takes the latest rate of its day for each purity; a correction is a new sheet.`}
        primary={canSet && !form && <button type="button" className="button" onClick={openForm}><Icon name="edit" size={16} /> Set today's rates</button>}
        secondary={<>
          <Link className="button button-secondary" to={biz.path("rate-board")}><Icon name="grid" size={15} /> Rate board</Link>
          {board.rates.length > 0 && <a className="button button-secondary" href={ratesShareLink(biz, board)} target="_blank" rel="noopener noreferrer"><Icon name="message" size={15} /> Share today's rates</a>}
        </>} />
      <ErrorMessage message={error} />
      {form && (
        <form onSubmit={save}>
          <SectionCard icon="edit" title="A new rate sheet" description="Leave a purity empty to keep its rate in use. The old metal rate is what the shop pays per gram for old jewellery of that purity.">
            <div className="form-grid bz-form">
              <Field label="Session"><select value={form.session} onChange={(e) => setForm((f) => ({ ...f, session: e.target.value }))}>
                {Object.entries(SESSION_WORDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="Rates from"><select value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}>
                {board.sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
              <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="e.g. 22K corrected after the IBJA closing rate" /></Field>
            </div>
            <table className="jw-rate-form">
              <thead><tr><th scope="col">Purity</th><th scope="col">Selling rate per gram</th><th scope="col">Old metal rate per gram</th></tr></thead>
              <tbody>
                {form.rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.label}</th>
                    <td><input type="number" min="0.01" step="0.01" inputMode="decimal" aria-label={`${r.label}: selling rate per gram`} value={r.sell} onChange={(e) => setRow(r.key, { sell: e.target.value })} /></td>
                    <td><input type="number" min="0.01" step="0.01" inputMode="decimal" aria-label={`${r.label}: old metal rate per gram`} value={r.buy} disabled={!r.sell.trim()} onChange={(e) => setRow(r.key, { buy: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ErrorMessage message={formError} />
            <div className="form-actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
              <button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> {busy ? "Saving…" : "Set these rates"}</button>
            </div>
          </SectionCard>
        </form>
      )}
      <SectionCard icon="tag" title="In use now" description={board.rates.length ? `${board.sheets} ${board.sheets === 1 ? "sheet" : "sheets"} set today.` : "No rates are set today yet: bills and old gold wait for them."}>
        {board.rates.length > 0 && (
          <table className="jw-rates">
            <thead><tr><th scope="col">Purity</th><th scope="col">Sells at</th><th scope="col">Old metal</th><th scope="col">Set</th></tr></thead>
            <tbody>
              {board.rates.map((r) => (
                <tr key={`${r.metal}:${r.purity}`}>
                  <th scope="row">{r.label}</th>
                  <td><strong>{perGram(biz, r.sell_rate)}</strong>{r.metal === "gold" && <small className="muted"> · 10 g {biz.exact(Number(r.sell_rate) * 10)}</small>}</td>
                  <td>{r.buy_rate ? perGram(biz, r.buy_rate) : <span className="muted">Not bought</span>}</td>
                  <td><span className="bz-two-line"><span>{dateTime(r.set_at)} · {SESSION_WORDS[r.session] || r.session}</span><small className="muted">{SOURCE_WORDS[r.source] || r.source} · {r.set_by_name}</small></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {board.notRated.length > 0 && board.rates.length > 0 && <p className="jw-note">Not rated today: {board.notRated.map((p) => p.label).join(", ")}.</p>}
      </SectionCard>
      <SectionCard flush icon="logbook" title="Every rate sheet">
        <ErrorMessage message={history.error} />
        <DataGrid {...history.gridProps} search={{ ...history.gridProps.search, placeholder: "Note, who set it, session" }} caption="Rate sheets" columns={columns}
          rowNoun={["sheet", "sheets"]} toolbar={<PeriodFilter list={history} />} empty="No rate sheets in these dates" emptyHint="Pick other dates." emptyIcon="tag"
          rowClassName={(s) => (s.replaced ? "dg-tone-muted" : "")} />
      </SectionCard>
    </div>
  );
}
