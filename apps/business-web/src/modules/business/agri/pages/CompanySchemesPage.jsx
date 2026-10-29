import { useEffect, useMemo, useState } from "react";
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
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { SEASONS, classOf, kindWord, normal, seasonWord } from "./agri";
import "../styles/agri.css";

// Company schemes: a supplier's scheme for a season, the items it counts,
// its dates and what reaching each quantity earns (a rebate on every unit at
// the slab reached, a target rebate, free goods, a gift). Its ledger is
// worked out from the purchases of those items from that supplier in its
// dates, less what went back; the claims made on it and what came back on
// each set what is still due. The ledger keeps account only: a credit note or
// free goods from the company are entered as any other.

const BENEFITS = [
  { value: "per_unit", label: "Rebate on every unit (slab)" }, { value: "target", label: "Target rebate" },
  { value: "free_goods", label: "Free goods" }, { value: "gift", label: "Gift" },
];
const benefitWord = (kind) => BENEFITS.find((b) => b.value === kind)?.label || kind;
const CLAIMS = [{ value: "money", label: "Money" }, { value: "free_goods", label: "Free goods" }, { value: "gift", label: "Gift" }];
const claimWord = (kind) => CLAIMS.find((c) => c.value === kind)?.label || kind;
const ITEMS = "catalog?active=true&kind=goods";
const emptyBenefit = () => ({ kind: "per_unit", minQuantity: "", rate: "", amount: "", freeSkuId: "", freeQuantity: "", gift: "" });

export default function CompanySchemesPage() {
  const biz = useOpenBusiness();
  const [show, setShow] = useState("true");
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);
  const canEdit = biz.can("purchasing.edit");
  const list = useServerList("agri/schemes", { gridId: "agri-schemes", params: show ? { active: show } : {} });
  const columns = useMemo(() => [
    { key: "name", header: "Scheme", value: (s) => s.name, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><button type="button" className="link-button bz-link-left" onClick={() => setOpenId(s.id)}>{s.name}</button><small className="muted">{s.supplier_name}</small></span> },
    { key: "season", header: "Season", value: (s) => seasonWord(s.season, s.season_year), mobile: "subtitle" },
    { key: "starts_on", header: "From", type: "date", value: (s) => s.starts_on },
    { key: "ends_on", header: "Until", type: "date", value: (s) => s.ends_on },
    { key: "items", header: "Items", type: "number", value: (s) => s.items },
    { key: "claims", header: "Claims", type: "number", value: (s) => s.claims,
      render: (s) => <span className="bz-inline">{s.claims}{s.awaited > 0 && <Badge tone="warning" label={`${s.awaited} awaited`} />}</span> },
    { key: "active", header: "State", value: (s) => (s.active ? "On" : "Off"), render: (s) => <ActiveBadge active={s.active} />, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => setOpenId(s.id)}>Ledger</button> },
  ], []);
  return (
    <div className="stack">
      <BusinessHeader icon="gift" title="Company schemes"
        description="Each company's scheme for a season: the items it counts, its slabs, target rebates, free goods and gifts, worked out from your purchases, with the claims made and what is still due."
        primary={canEdit && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a scheme</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="gift" title="Schemes">
        <DataGrid {...list.gridProps} caption="Company schemes" columns={columns} rowNoun={["scheme", "schemes"]}
          toolbar={(
            <label className="field">
              <span>Show</span>
              <select value={show} onChange={(e) => setShow(e.target.value)}>
                <option value="true">Switched on</option><option value="false">Switched off</option><option value="">Every scheme</option>
              </select>
            </label>
          )}
          exportName={biz.can("purchasing.export") ? `${biz.business.code}-company-schemes` : undefined}
          empty="No company schemes" emptyHint="Add a company's scheme to see what your purchases earn and what is still due on it." emptyIcon="gift" />
      </SectionCard>
      {editing && <SchemeDialog scheme={editing} onClose={() => setEditing(null)}
        onSaved={(d) => { setEditing(null); list.reload(); toast.success(`${d.scheme.name} saved.`); setOpenId(d.scheme.id); }} />}
      {openId && !editing && <SchemeLedger schemeId={openId} onClose={() => { setOpenId(null); list.reload(); }} onEdit={(d) => setEditing(d)} />}
    </div>
  );
}

// A new scheme, or its terms changed (its supplier stays).
function SchemeDialog({ scheme, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(scheme.scheme);
  const s = scheme.scheme || {};
  const today = businessToday(biz.business.timezone);
  const year = Number(today.slice(0, 4));
  const { options } = useOptions([ITEMS, ...(editing ? [] : ["contacts?kind=supplier&active=true"])]);
  const goods = options?.[ITEMS] || [];
  const [form, setForm] = useState({
    contactId: "", name: s.name || "", season: s.season || "kharif", seasonYear: String(s.season_year || year), startsOn: s.starts_on || "", endsOn: s.ends_on || "", notes: s.notes || "",
    skuIds: (scheme.items || []).map((i) => String(i.id)),
    benefits: (scheme.benefits || []).length ? scheme.benefits.map((b) => ({ kind: b.kind, minQuantity: String(Number(b.min_quantity)), rate: b.rate === null ? "" : String(Number(b.rate)),
      amount: b.amount === null ? "" : String(Number(b.amount)), freeSkuId: b.free_sku_id ? String(b.free_sku_id) : "", freeQuantity: b.free_quantity === null ? "" : String(Number(b.free_quantity)), gift: b.gift || "" }))
      : [emptyBenefit()],
  });
  const [find, setFind] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const setBenefit = (i, name, value) => setForm((f) => ({ ...f, benefits: f.benefits.map((b, n) => (n === i ? { ...b, [name]: value } : b)) }));
  const chosen = new Set(form.skuIds);
  const toggle = (skuId) => setForm((f) => ({ ...f, skuIds: chosen.has(skuId) ? f.skuIds.filter((x) => x !== skuId) : [...f.skuIds, skuId] }));
  const shown = goods.filter((g) => chosen.has(String(g.id)) || !find.trim() || normal(`${g.label} ${g.code || ""}`).includes(normal(find))).slice(0, 200);
  const unit = goods.find((g) => chosen.has(String(g.id)))?.unit;
  const submit = () => {
    const body = { name: form.name.trim(), season: form.season, seasonYear: Number(form.seasonYear), startsOn: form.startsOn, endsOn: form.endsOn, notes: form.notes.trim() || null,
      skuIds: form.skuIds.map(Number),
      benefits: form.benefits.map((b) => ({ kind: b.kind, minQuantity: b.minQuantity || "0",
        ...(b.kind === "per_unit" ? { rate: b.rate } : b.kind === "target" ? { amount: b.amount } : b.kind === "free_goods" ? { freeSkuId: Number(b.freeSkuId), freeQuantity: b.freeQuantity } : { gift: b.gift.trim() }) })) };
    if (editing) return businessWrite(biz.id, `agri/schemes/${s.id}`, { ...body, active: s.active }, "put");
    return businessWrite(biz.id, "agri/schemes", { ...body, contactId: form.contactId });
  };
  return (
    <FormDialog title={editing ? `${s.name}: the terms` : "Add a company scheme"} icon="gift" width={860} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="The scheme counts the units bought of its items from the supplier in its dates, as your purchases show them. Of each kind, the highest tier reached counts.">
      {!editing && (
        <Field label="Supplier (the company)" wide>
          <select required value={form.contactId} onChange={set("contactId")}>
            <option value="">Choose the supplier…</option>
            {(options?.["contacts?kind=supplier&active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Name of the scheme" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Kharif booking scheme" /></Field>
      <Field label="Season"><select value={form.season} onChange={set("season")}>{SEASONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
      <Field label="Year"><select value={form.seasonYear} onChange={set("seasonYear")}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
      <Field label="From"><input type="date" required value={form.startsOn} onChange={set("startsOn")} /></Field>
      <Field label="Until"><input type="date" required min={form.startsOn || undefined} value={form.endsOn} onChange={set("endsOn")} /></Field>
      <fieldset className="field-wide agri-fieldset">
        <legend>Items it counts ({form.skuIds.length}{unit ? `, counted in ${unit}` : ""})</legend>
        <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find an item" aria-label="Find an item" />
        {!options ? <Loading /> : (
          <ul className="agri-pick-list">
            {shown.map((g) => {
              const c = classOf(g);
              return (
                <li key={g.id}>
                  <label className="checkbox"><input type="checkbox" checked={chosen.has(String(g.id))} onChange={() => toggle(String(g.id))} /> {g.label}
                    <small className="muted"> · {[kindWord(c.kind), g.unit].filter(Boolean).join(" · ")}</small></label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <fieldset className="field-wide agri-fieldset">
        <legend>What reaching each quantity earns</legend>
        {form.benefits.map((b, i) => (
          <div key={i} className="agri-benefit-row">
            <Field label="Kind">
              <select value={b.kind} onChange={(e) => setBenefit(i, "kind", e.target.value)}>{BENEFITS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
            </Field>
            <Field label={`From quantity${unit ? ` (${unit})` : ""}`}>
              <input type="number" required min="0" step="0.001" inputMode="decimal" value={b.minQuantity} onChange={(e) => setBenefit(i, "minQuantity", e.target.value)} />
            </Field>
            {b.kind === "per_unit" && <Field label={`Rebate a ${unit || "unit"}`}><input type="number" required min="0.01" step="0.01" inputMode="decimal" value={b.rate} onChange={(e) => setBenefit(i, "rate", e.target.value)} /></Field>}
            {b.kind === "target" && <Field label="Rebate on reaching it"><input type="number" required min="0.01" step="0.01" inputMode="decimal" value={b.amount} onChange={(e) => setBenefit(i, "amount", e.target.value)} /></Field>}
            {b.kind === "free_goods" && (
              <>
                <Field label="Free item">
                  <select required value={b.freeSkuId} onChange={(e) => setBenefit(i, "freeSkuId", e.target.value)}>
                    <option value="">Choose…</option>
                    {goods.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </Field>
                <Field label="Free quantity"><input type="number" required min="0.001" step="0.001" inputMode="decimal" value={b.freeQuantity} onChange={(e) => setBenefit(i, "freeQuantity", e.target.value)} /></Field>
              </>
            )}
            {b.kind === "gift" && <Field label="Gift"><input required maxLength={150} value={b.gift} onChange={(e) => setBenefit(i, "gift", e.target.value)} placeholder="e.g. a sprayer" /></Field>}
            {form.benefits.length > 1 && (
              <button type="button" className="icon-button" aria-label="Remove this tier" onClick={() => setForm((f) => ({ ...f, benefits: f.benefits.filter((_, n) => n !== i) }))}><Icon name="trash" size={15} /></button>
            )}
          </div>
        ))}
        {form.benefits.length < 30 && <button type="button" className="button button-secondary button-sm" onClick={() => setForm((f) => ({ ...f, benefits: [...f.benefits, emptyBenefit()] }))}><Icon name="plus" size={14} /> Add a tier</button>}
      </fieldset>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function SchemeLedger({ schemeId, onClose, onEdit }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null);
  const [billId, setBillId] = useState(null);
  const canEdit = biz.can("purchasing.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `agri/schemes/${schemeId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, schemeId]);
  const s = data?.scheme;
  const saved = (d, message) => { setData(d); setAction(null); toast.success(message); };
  async function switchTo(active) {
    try {
      const d = await businessWrite(biz.id, `agri/schemes/${s.id}`, { name: s.name, season: s.season, seasonYear: s.season_year, startsOn: s.starts_on, endsOn: s.ends_on, notes: s.notes,
        skuIds: data.items.map((i) => i.id), active,
        benefits: data.benefits.map((b) => ({ kind: b.kind, minQuantity: b.min_quantity, rate: b.rate ?? undefined, amount: b.amount ?? undefined, freeSkuId: b.free_sku_id ?? undefined,
          freeQuantity: b.free_quantity ?? undefined, gift: b.gift ?? undefined })) }, "put");
      saved(d, active ? "Switched on." : "Switched off: its ledger is kept.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }
  const unit = data?.unit || "";
  const due = data?.due;
  return (
    <>
      <Modal title={s ? s.name : "Loading…"} icon="gift" width={980} onClose={() => { if (!action && !billId) onClose(); }}
        description={s ? `${s.supplier_name} · ${seasonWord(s.season, s.season_year)} · ${dateShort(s.starts_on, { year: true })} to ${dateShort(s.ends_on, { year: true })}${s.active ? "" : " · switched off"}` : undefined}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack bz-detail">
            <div className="stat-grid bz-stat-grid">
              <StatTile icon="box" tone="primary" label="Bought so far" value={quantity(data.bought, unit)} note={`${data.items.length} item${data.items.length === 1 ? "" : "s"} counted`} />
              <StatTile icon="rupee" label="Earned" money={data.earned.money}
                note={[Number(data.earned.rebate) > 0 && `${biz.exact(data.earned.rate)} a ${unit || "unit"}`, Number(data.earned.target) > 0 && `target ${biz.exact(data.earned.target)}`].filter(Boolean).join(" + ") || "no tier reached yet"} />
              <StatTile icon="wallet" tone={Number(due.money.due) > 0 ? "warning" : undefined} label="Still due" money={due.money.due}
                note={`${biz.exact(due.money.received)} received, ${biz.exact(due.money.awaited)} claimed and awaited`} />
              {data.earned.freeGoods && <StatTile icon="gift" label="Free goods earned" value={quantity(data.earned.freeGoods.quantity, data.earned.freeGoods.unit)}
                note={`${data.earned.freeGoods.label}: ${quantity(due.freeGoods.due, data.earned.freeGoods.unit)} still due`} />}
              {data.earned.gift && <StatTile icon="star" label="Gift earned" value={data.earned.gift} note={due.gift.received ? "received" : due.gift.claimed ? "claimed, awaited" : "not claimed yet"} />}
            </div>
            {data.next.length > 0 && (
              <ul className="agri-next">
                {data.next.map((n) => <li key={n.kind}><Icon name="trend-up" size={14} /> {quantity(n.short, unit)} more reaches the next {benefitWord(n.kind).toLowerCase()} tier, at {quantity(n.minQuantity, unit)}.</li>)}
              </ul>
            )}
            <table className="agri-licence-table">
              <caption className="agri-subhead">Tiers</caption>
              <thead><tr><th>Kind</th><th>From</th><th>Earns</th></tr></thead>
              <tbody>
                {data.benefits.map((b) => (
                  <tr key={b.id}>
                    <td>{benefitWord(b.kind)}</td><td>{quantity(b.min_quantity, unit)}</td>
                    <td>{b.kind === "per_unit" ? `${biz.exact(b.rate)} a ${unit || "unit"} on every unit` : b.kind === "target" ? biz.exact(b.amount)
                      : b.kind === "free_goods" ? `${quantity(b.free_quantity, b.free_unit)} of ${b.free_label}` : b.gift}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <DataGrid variant="compact" id="agri-scheme-purchases" caption="Purchases counted" rows={data.purchases} rowKey={(p) => p.line_id} currency={biz.symbol} rowNoun={["line", "lines"]}
              empty="No purchases counted yet" columns={[
                { key: "document_no", header: "Purchase", value: (p) => p.document_no, mobile: "title",
                  render: (p) => <button type="button" className="link-button mono" onClick={() => setBillId(p.document_id)}>{p.document_no}</button> },
                { key: "supplier_bill_no", header: "Supplier's bill", value: (p) => p.supplier_bill_no || "", className: "mono" },
                { key: "day", header: "Received", type: "date", value: (p) => p.day, mobile: "subtitle" },
                { key: "label", header: "Item", value: (p) => p.label },
                { key: "paid", header: "Paid for", type: "number", value: (p) => Number(p.paid), render: (p) => quantity(p.paid, p.unit) },
                { key: "returned", header: "Sent back", type: "number", value: (p) => Number(p.returned), render: (p) => (Number(p.returned) ? quantity(p.returned, p.unit) : "") },
                { key: "counted", header: "Counted", type: "number", value: (p) => Number(p.counted), total: "sum", mobile: "show" },
                { key: "earns", header: "Rebate at the slab reached", type: "money", exact: true, value: (p) => Number(p.earns), total: "sum" },
              ]} />
            <DataGrid variant="compact" id="agri-scheme-claims" caption="Claims" rows={data.claims} currency={biz.symbol} rowNoun={["claim", "claims"]} empty="No claims made yet"
              columns={[
                { key: "claimed_on", header: "Claimed", type: "date", value: (k) => k.claimed_on, mobile: "subtitle" },
                { key: "kind", header: "For", value: (k) => claimWord(k.kind), mobile: "title" },
                { key: "reference", header: "Reference", value: (k) => k.reference || "", className: "mono" },
                { key: "claimed", header: "Claimed", value: (k) => (k.kind === "money" ? biz.exact(k.amount) : k.kind === "free_goods" ? quantity(k.quantity, data.earned.freeGoods?.unit) : k.description) },
                { key: "received_on", header: "Received", type: "date", value: (k) => k.received_on,
                  render: (k) => (k.received_on ? dateShort(k.received_on, { year: true }) : <Badge tone="warning" label="Awaited" />) },
                { key: "received", header: "What came back", value: (k) => (!k.received_on ? "" : k.kind === "money" ? biz.exact(k.received_amount) : k.kind === "free_goods" ? quantity(k.received_quantity, data.earned.freeGoods?.unit) : "Received"), mobile: "show" },
                { key: "received_reference", header: "Credit note", value: (k) => k.received_reference || "", className: "mono", defaultHidden: true },
                { key: "actions", header: "", label: "Actions", type: "actions",
                  render: (k) => canEdit && !k.received_on && <button type="button" className="chip-button" onClick={() => setAction({ receive: k })}>Mark received</button> },
              ]} />
            <p className="small muted">Items counted: {data.items.map((i) => i.label).join(", ")}.{s.notes ? ` ${s.notes}` : ""}</p>
            {canEdit && (
              <div className="form-actions bz-start">
                <button type="button" className="button" onClick={() => setAction({ claim: true })}><Icon name="file" size={15} /> Record a claim</button>
                <button type="button" className="button button-secondary" onClick={() => onEdit(data)}><Icon name="edit" size={15} /> Change the terms</button>
                <button type="button" className="button button-secondary" onClick={() => switchTo(!s.active)}>{s.active ? "Switch it off" : "Switch it on"}</button>
              </div>
            )}
          </div>
        )}
      </Modal>
      {action?.claim && <ClaimDialog ledger={data} onClose={() => setAction(null)} onSaved={(d) => saved(d, "Claim recorded.")} />}
      {action?.receive && <ReceiveDialog ledger={data} claim={action.receive} onClose={() => setAction(null)} onSaved={(d) => saved(d, "What came back is recorded.")} />}
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} />}
    </>
  );
}

function ClaimDialog({ ledger, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const due = ledger.due;
  const free = ledger.earned.freeGoods;
  const [form, setForm] = useState({ kind: "money", claimedOn: today, reference: "", amount: Number(due.money.unclaimed) > 0 ? String(Number(due.money.unclaimed)) : "",
    quantity: free ? String(Math.max(0, Number(free.quantity) - Number(due.freeGoods.claimed))) : "", description: ledger.earned.gift || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, `agri/schemes/${ledger.scheme.id}/claims`, { kind: form.kind, claimedOn: form.claimedOn, reference: form.reference.trim() || null,
    ...(form.kind === "money" ? { amount: form.amount } : form.kind === "free_goods" ? { quantity: form.quantity } : {}), description: form.description.trim() || null });
  return (
    <FormDialog title="Record a claim" icon="file" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`Earned so far: ${biz.exact(ledger.earned.money)}, of which ${biz.exact(due.money.unclaimed)} is not claimed yet.`}>
      <Field label="Claim for"><select value={form.kind} onChange={set("kind")}>{CLAIMS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field>
      <Field label="Claimed on"><input type="date" required min={ledger.scheme.starts_on} max={today} value={form.claimedOn} onChange={set("claimedOn")} /></Field>
      {form.kind === "money" && <Field label="Amount claimed"><input type="number" required min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={set("amount")} /></Field>}
      {form.kind === "free_goods" && <Field label={`Quantity claimed${free ? ` (${free.unit})` : ""}`}><input type="number" required min="0.001" step="0.001" inputMode="decimal" value={form.quantity} onChange={set("quantity")} /></Field>}
      <Field label="Claim reference (optional)"><input maxLength={80} className="mono" value={form.reference} onChange={set("reference")} /></Field>
      <Field label={form.kind === "gift" ? "The gift" : "Description (optional)"} wide><input required={form.kind === "gift"} maxLength={300} value={form.description} onChange={set("description")} /></Field>
    </FormDialog>
  );
}

function ReceiveDialog({ ledger, claim, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ receivedOn: today, receivedAmount: claim.amount === null ? "" : String(Number(claim.amount)),
    receivedQuantity: claim.quantity === null ? "" : String(Number(claim.quantity)), receivedReference: "", receivedNote: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, `agri/schemes/${ledger.scheme.id}/claims/${claim.id}/received`, { receivedOn: form.receivedOn,
    ...(claim.kind === "money" ? { receivedAmount: form.receivedAmount } : claim.kind === "free_goods" ? { receivedQuantity: form.receivedQuantity } : {}),
    receivedReference: form.receivedReference.trim() || null, receivedNote: form.receivedNote.trim() || null });
  return (
    <FormDialog title={`What came back on the ${claimWord(claim.kind).toLowerCase()} claim`} icon="check" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="Recorded once. Enter the company's credit note or the free goods themselves as any other: this only keeps the scheme's account.">
      <Field label="Received on"><input type="date" required min={claim.claimed_on} max={today} value={form.receivedOn} onChange={set("receivedOn")} /></Field>
      {claim.kind === "money" && <Field label="Amount received"><input type="number" required min="0" step="0.01" inputMode="decimal" value={form.receivedAmount} onChange={set("receivedAmount")} /></Field>}
      {claim.kind === "free_goods" && <Field label="Quantity received"><input type="number" required min="0" step="0.001" inputMode="decimal" value={form.receivedQuantity} onChange={set("receivedQuantity")} /></Field>}
      <Field label="Credit note or reference (optional)"><input maxLength={80} className="mono" value={form.receivedReference} onChange={set("receivedReference")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.receivedNote} onChange={set("receivedNote")} /></Field>
    </FormDialog>
  );
}
