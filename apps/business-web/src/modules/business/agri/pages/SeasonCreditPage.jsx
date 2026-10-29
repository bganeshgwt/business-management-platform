import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { INTEREST, SEASONS, interestWord, seasonWord } from "./agri";
import "../styles/agri.css";

// Season credit: each farmer's credit for a season (kharif, rabi or zaid of a
// year): its limit, the date its bills fall due (the harvest), its interest on
// overdue, a guarantor and the crop pledged. The counter bills on it within
// its limit. Interest is worked out to the paisa, bill by bill, and billed
// only when someone confirms it; produce taken from the farmer pays the
// season's bills (no money moves). Terms are a manager's (agri.approve); the
// due date and interest stay as they were once a bill is on the season.

const UNITS = [{ value: "quintal", label: "Quintal" }, { value: "kg", label: "Kg" }, { value: "bag", label: "Bag" }, { value: "tonne", label: "Tonne" }];
const STATES = [{ value: "open", label: "Open" }, { value: "overdue", label: "Overdue" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }];

export default function SeasonCreditPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState("open");
  const [openId, setOpenId] = useState(() => params.get("season") || null);
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && biz.can("agri.approve") ? {} : null));
  const money = biz.can("sales.view") || biz.can("receivables.view");
  useEffect(() => {
    if (params.get("new") || params.get("season")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); next.delete("season"); return next; }, { replace: true });
  }, [params, setParams]);
  const filters = { open: { closed: "false" }, overdue: { overdue: "true" }, closed: { closed: "true" }, all: {} }[state];
  const list = useServerList("agri/season-credits", { gridId: "agri-season-credits", params: filters });
  const columns = useMemo(() => [
    { key: "name", header: "Farmer", value: (s) => s.name, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><button type="button" className="link-button bz-link-left" onClick={() => setOpenId(s.id)}>{s.name}</button>{s.village && <small className="muted">{s.village}</small>}</span> },
    { key: "season", header: "Season", value: (s) => seasonWord(s.season, s.season_year), mobile: "subtitle" },
    { key: "due_on", header: "Falls due", type: "date", value: (s) => s.due_on,
      render: (s) => <span className="bz-inline">{dateShort(s.due_on, { year: true })}{money && s.overdue && <Badge tone="danger" label="Overdue" />}{s.closed && <Badge tone="neutral" label="Closed" />}</span> },
    money && { key: "credit_limit", header: "Limit", type: "money", exact: true, value: (s) => (s.credit_limit === null ? null : Number(s.credit_limit)),
      render: (s) => (s.credit_limit === null ? <span className="muted">No limit</span> : biz.exact(s.credit_limit)) },
    money && { key: "owed", header: "Owed", type: "money", exact: true, value: (s) => Number(s.owed), total: "sum", mobile: "show" },
    { key: "interest", header: "Interest", value: (s) => interestWord(s) },
    money && { key: "interest_billed", header: "Interest billed", type: "money", exact: true, value: (s) => Number(s.interest_billed), defaultHidden: true },
    { key: "guarantor_name", header: "Guarantor", value: (s) => s.guarantor_name || "", defaultHidden: true },
    { key: "crop_pledged", header: "Crop pledged", value: (s) => s.crop_pledged || "", defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => setOpenId(s.id)}>Open</button> },
  ].filter(Boolean), [biz, money]);
  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title="Season credit"
        description="Each farmer's credit for a season: its limit, the harvest date it falls due, its interest on overdue, a guarantor and the crop pledged. Interest is billed only when you confirm it; produce taken from a farmer pays the season's bills."
        primary={biz.can("agri.approve") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Give season credit</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="wallet" title="Seasons">
        <DataGrid {...list.gridProps} caption="Season credit" columns={columns} currency={biz.symbol} rowNoun={["season", "seasons"]}
          toolbar={(
            <label className="field">
              <span>Show</span>
              <select value={state} onChange={(e) => setState(e.target.value)}>
                {STATES.filter((s) => money || s.value !== "overdue").map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          )}
          exportName={biz.can("receivables.export") ? `${biz.business.code}-season-credit` : undefined}
          empty="No season credit" emptyHint="Give a farmer season credit here, or choose a season for a bill on udhaar at Quick bill." emptyIcon="wallet" />
      </SectionCard>
      {editing && <SeasonDialog season={editing} onClose={() => setEditing(null)}
        onSaved={(d) => { setEditing(null); list.reload(); toast.success(`${d.season.name}'s ${seasonWord(d.season.season, d.season.season_year)} credit saved.`); if (!editing.id) setOpenId(d.season.id); }} />}
      {openId && <SeasonDetail seasonId={openId} onClose={() => { setOpenId(null); list.reload(); }} onEdit={(s) => setEditing(s)} />}
    </div>
  );
}

// New season credit, or its terms changed (its farmer and season stay).
function SeasonDialog({ season, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(season.id);
  const today = businessToday(biz.business.timezone);
  const year = Number(today.slice(0, 4));
  const { options } = useOptions(editing ? [] : ["contacts?kind=customer&active=true"]);
  const [form, setForm] = useState({
    contactId: "", season: season.season || "kharif", seasonYear: String(season.season_year || year), dueOn: season.due_on || "",
    creditLimit: season.credit_limit ? String(Number(season.credit_limit)) : "", interest: season.interest || "none",
    interestRate: season.interest_rate ? String(Number(season.interest_rate)) : "", guarantorName: season.guarantor_name || "",
    guarantorPhone: season.guarantor_phone || "", guarantorAddress: season.guarantor_address || "", cropPledged: season.crop_pledged || "", notes: season.notes || "",
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const fixed = editing && season.bills > 0;
  const submit = () => {
    const body = { dueOn: form.dueOn, creditLimit: form.creditLimit || null, interest: form.interest, interestRate: form.interest === "none" ? null : form.interestRate,
      guarantorName: form.guarantorName.trim() || null, guarantorPhone: form.guarantorPhone.trim() || null, guarantorAddress: form.guarantorAddress.trim() || null,
      cropPledged: form.cropPledged.trim() || null, notes: form.notes.trim() || null };
    if (editing) return businessWrite(biz.id, `agri/season-credits/${season.id}`, { ...body, closed: Boolean(season.closed_at) }, "put");
    return businessWrite(biz.id, "agri/season-credits", { ...body, contactId: form.contactId, season: form.season, seasonYear: Number(form.seasonYear) });
  };
  return (
    <FormDialog title={editing ? `${season.name}: ${seasonWord(season.season, season.season_year)} credit` : "Give season credit"} icon="wallet" width={680}
      onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={fixed ? "Its bills fall due on its date and carry its interest as given: those stay. The limit, the guarantor and the crop pledged may change." : "The season's bills fall due at the harvest date, and are held to its limit at the counter."}>
      {!editing && (
        <>
          <Field label="Farmer" wide>
            <select required value={form.contactId} onChange={set("contactId")}>
              <option value="">Choose the customer…</option>
              {(options?.["contacts?kind=customer&active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Season">
            <select value={form.season} onChange={set("season")}>{SEASONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
          </Field>
          <Field label="Year">
            <select value={form.seasonYear} onChange={set("seasonYear")}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</select>
          </Field>
        </>
      )}
      <Field label="Falls due on (the harvest)"><input type="date" required disabled={fixed} min={editing ? undefined : today} value={form.dueOn} onChange={set("dueOn")} /></Field>
      <Field label="Credit limit (optional)" hint="Leave empty for no limit of its own."><input type="number" min="0.01" step="0.01" inputMode="decimal" value={form.creditLimit} onChange={set("creditLimit")} /></Field>
      <Field label="Interest on overdue">
        <select value={form.interest} disabled={fixed} onChange={set("interest")}>{INTEREST.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}</select>
      </Field>
      {form.interest !== "none" && (
        <Field label="% a month" hint="Simple interest on what is owed each day: a thirtieth of it a day.">
          <input type="number" required disabled={fixed} min="0.01" max="10" step="0.01" inputMode="decimal" value={form.interestRate} onChange={set("interestRate")} />
        </Field>
      )}
      <Field label="Guarantor (optional)"><input maxLength={150} value={form.guarantorName} onChange={set("guarantorName")} /></Field>
      <Field label="Guarantor's phone (optional)"><input maxLength={30} inputMode="tel" value={form.guarantorPhone} onChange={set("guarantorPhone")} /></Field>
      <Field label="Guarantor's address (optional)" wide><input maxLength={300} value={form.guarantorAddress} onChange={set("guarantorAddress")} /></Field>
      <Field label="Crop pledged (optional)" wide><input maxLength={200} value={form.cropPledged} onChange={set("cropPledged")} placeholder="e.g. Paddy, 3 acres" /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function SeasonDetail({ seasonId, onClose, onEdit }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [billId, setBillId] = useState(null);
  const [action, setAction] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `agri/season-credits/${seasonId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, seasonId, version]);
  const s = data?.season;
  const changed = (message) => { setAction(null); setVersion((n) => n + 1); if (message) toast.success(message); };
  async function close(closed) {
    try {
      await businessWrite(biz.id, `agri/season-credits/${s.id}`, { dueOn: s.due_on, creditLimit: s.credit_limit, interest: s.interest, interestRate: s.interest_rate,
        guarantorName: s.guarantor_name, guarantorPhone: s.guarantor_phone, guarantorAddress: s.guarantor_address, cropPledged: s.crop_pledged, notes: s.notes, closed }, "put");
      changed(closed ? "Closed: it takes no new bills." : "Open again for new bills.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }
  const i = data?.interest;
  return (
    <>
      <Modal title={s ? `${s.name}: ${seasonWord(s.season, s.season_year)} credit` : "Loading…"} icon="wallet" width={900} onClose={() => { if (!billId && !action) onClose(); }}
        description={s ? [s.village, `falls due ${dateShort(s.due_on, { year: true })}`, s.closed_at ? "closed" : null].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack bz-detail">
            <dl className="agri-facts">
              <div><dt>Falls due</dt><dd>{dateShort(s.due_on, { year: true })}</dd></div>
              {data.money && <div><dt>Limit</dt><dd>{s.credit_limit === null ? "No limit of its own" : biz.exact(s.credit_limit)}</dd></div>}
              <div><dt>Interest</dt><dd>{interestWord(s)}</dd></div>
              {s.guarantor_name && <div><dt>Guarantor</dt><dd>{[s.guarantor_name, s.guarantor_phone, s.guarantor_address].filter(Boolean).join(" · ")}</dd></div>}
              {s.crop_pledged && <div><dt>Crop pledged</dt><dd>{s.crop_pledged}</dd></div>}
              {s.notes && <div><dt>Notes</dt><dd>{s.notes}</dd></div>}
            </dl>
            {data.money ? (
              <>
                <div className="stat-grid bz-stat-grid">
                  <StatTile icon="wallet" tone="primary" label="Owed on the season" money={data.owed} />
                  {data.left !== null && <StatTile icon="scale" label="Left of the limit" money={data.left} />}
                  {s.interest !== "none" && <StatTile icon="percent" tone={Number(i.due) > 0 ? "warning" : undefined} label="Interest due now" money={i.due} note={`${biz.exact(i.worked)} worked out to ${dateShort(i.upTo, { year: true })}, ${biz.exact(i.billed)} billed`} />}
                </div>
                <DataGrid variant="compact" id="agri-season-bills" caption="Bills on the season" rows={data.bills} currency={biz.symbol} rowNoun={["bill", "bills"]} empty="No bills on it yet"
                  columns={[
                    { key: "document_no", header: "Bill", value: (b) => b.document_no, mobile: "title",
                      render: (b) => (biz.can("sales.view") ? <button type="button" className="link-button mono" onClick={() => setBillId(b.id)}>{b.document_no}</button> : b.document_no) },
                    { key: "day", header: "Billed", type: "date", value: (b) => b.day, mobile: "subtitle" },
                    { key: "kind", header: "For", value: (b) => (b.interest_bill ? "Interest" : "Farm inputs") },
                    { key: "total", header: "Total", type: "money", exact: true, value: (b) => Number(b.total) },
                    { key: "balance", header: "Left to collect", type: "money", exact: true, value: (b) => Number(b.balance), total: "sum", mobile: "show" },
                    s.interest !== "none" && { key: "interest", header: "Interest to date", type: "money", exact: true, value: (b) => Number(b.interest), total: "sum" },
                  ].filter(Boolean)} />
                {s.interest !== "none" && i.bills.length > 0 && (
                  <details className="agri-workings">
                    <summary>How the interest is worked out</summary>
                    <p className="small muted">{interestWord(s)}: each day {s.interest === "after_due" ? "after the due date" : "after the bill's date"}, up to {dateShort(i.upTo, { year: true })}, earns a thirtieth of the month's % on what was owed at the end of that day. Each bill's interest is rounded to the paisa.</p>
                    <table className="agri-licence-table">
                      <thead><tr><th>Bill</th><th>From</th><th>Days</th><th>Owed</th><th className="r">Interest</th></tr></thead>
                      <tbody>
                        {i.bills.map((b) => b.periods.map((p, n) => (
                          <tr key={`${b.documentId}-${p.from}`}>
                            <th scope="row">{n === 0 ? b.documentNo : ""}</th><td>{dateShort(p.from)} – {dateShort(p.to)}</td><td>{p.days}</td><td>{biz.exact(p.owed)}</td>
                            <td className="r">{n === b.periods.length - 1 ? biz.exact(b.interest) : ""}</td>
                          </tr>
                        )))}
                      </tbody>
                    </table>
                  </details>
                )}
                {data.produce.length > 0 && (
                  <DataGrid variant="compact" id="agri-season-produce" caption="Produce taken" rows={data.produce} currency={biz.symbol} rowNoun={["receipt", "receipts"]}
                    columns={[
                      { key: "receipt_no", header: "No.", value: (p) => `PR-${p.receipt_no}`, className: "mono", mobile: "title" },
                      { key: "created_at", header: "Taken", type: "date", value: (p) => p.created_at, mobile: "subtitle" },
                      { key: "crop", header: "Crop", value: (p) => p.crop },
                      { key: "quantity", header: "Quantity", value: (p) => `${quantity(p.quantity)} ${p.unit}` },
                      { key: "rate", header: "Rate", type: "money", exact: true, value: (p) => Number(p.rate) },
                      { key: "value", header: "Value", type: "money", exact: true, value: (p) => Number(p.value), total: "sum", mobile: "show" },
                    ]} />
                )}
              </>
            ) : <p className="small muted">Your role does not see customers' dues.</p>}
            <div className="form-actions bz-start">
              {data.money && s.interest !== "none" && Number(i.due) > 0 && biz.can("agri.approve") && biz.can("sales.create") && (
                <button type="button" className="button" onClick={() => setAction("interest")}><Icon name="percent" size={15} /> Bill the interest of {biz.exact(i.due)}</button>
              )}
              {data.money && Number(data.owed) > 0 && biz.can("receivables.create") && (
                <button type="button" className="button button-secondary" onClick={() => setAction("produce")}><Icon name="scale" size={15} /> Take produce against it</button>
              )}
              {biz.can("agri.approve") && <button type="button" className="button button-secondary" onClick={() => onEdit({ ...s, bills: data.bills?.length || 0 })}><Icon name="edit" size={15} /> Change the terms</button>}
              {biz.can("agri.approve") && <button type="button" className="button button-secondary" onClick={() => close(!s.closed_at)}>{s.closed_at ? "Open it again" : "Close it"}</button>}
            </div>
          </div>
        )}
      </Modal>
      {action === "interest" && <InterestDialog season={s} due={i.due} upTo={i.upTo} onClose={() => setAction(null)}
        onSaved={(r) => changed(`Interest of ${biz.exact(i.due)} billed on ${r.charges.at(-1)?.document_no || "a new bill"}.`)} />}
      {action === "produce" && <ProduceDialog season={s} owed={data.owed} onClose={() => setAction(null)}
        onSaved={(r) => changed(`Produce worth ${biz.exact(r.receipt.value)} taken as PR-${r.receipt.receipt_no}.`)} />}
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => setVersion((n) => n + 1)} />}
    </>
  );
}

function InterestDialog({ season, due, upTo, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || locations[0]?.id || ""));
  const submit = () => businessWrite(biz.id, `agri/season-credits/${season.id}/interest`, { requestKey, locationId, amount: due });
  return (
    <FormDialog title={`Bill the interest of ${biz.exact(due)}`} icon="percent" width={520} submitLabel="Bill it" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${season.name}'s ${seasonWord(season.season, season.season_year)} credit, worked out to ${dateShort(upTo, { year: true })}. A bill of the interest item goes on the season, due at once; interest never earns interest.`}>
      {locations.length > 1 && (
        <Field label="Billed at">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
      <p className="field-wide small muted">The item interest is billed as, and its GST slab, are set under Settings › Farm input checks.</p>
    </FormDialog>
  );
}

function ProduceDialog({ season, owed, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ locationId: String(biz.currentLocationId || locations[0]?.id || ""), crop: "", quantity: "", unit: "quintal", rate: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  // quantity × rate to the paisa, as the server works it out.
  const value = Number(form.quantity) > 0 && Number(form.rate) > 0 ? Math.round(Math.round(Number(form.quantity) * 1000) * Math.round(Number(form.rate) * 100) / 1000) / 100 : 0;
  const submit = () => businessWrite(biz.id, `agri/season-credits/${season.id}/produce`, { requestKey, locationId: form.locationId, crop: form.crop.trim(), quantity: form.quantity,
    unit: form.unit, rate: form.rate, notes: form.notes.trim() || undefined });
  return (
    <FormDialog title="Take produce against the season" icon="scale" width={600} submitLabel={value ? `Take it · ${biz.exact(value)}` : "Take it"} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${season.name} owes ${biz.exact(owed)} on ${seasonWord(season.season, season.season_year)} credit. The produce's value pays the season's bills, oldest due first, as a payment named Produce: no money moves, and the day's money does not count it.`}>
      {locations.length > 1 && (
        <Field label="Taken at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      <Field label="Crop"><input required maxLength={100} value={form.crop} onChange={set("crop")} placeholder="e.g. Paddy (BPT 5204)" /></Field>
      <Field label="Quantity"><input type="number" required min="0.001" step="0.001" inputMode="decimal" value={form.quantity} onChange={set("quantity")} /></Field>
      <Field label="Unit"><select value={form.unit} onChange={set("unit")}>{UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></Field>
      <Field label={`Rate a ${form.unit}`}><input type="number" required min="0.01" step="0.01" inputMode="decimal" value={form.rate} onChange={set("rate")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder="e.g. weighed at the shop, moisture 14%" /></Field>
      {value > Number(owed) && <p className="field-wide agri-stop">That is worth more than is owed on the season: take less, or settle the rest in money.</p>}
    </FormDialog>
  );
}
