import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { isContactLensItem, lensDueLink } from "./optical";
// A reminder needs the customer's consent to reminders (asked first, in one tap).
import ConsentLink from "../../../personal-data/components/ConsentLink";
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import "../styles/optical.css";

// Contact lenses after the sale: each customer's lenses running out (the
// lenses on their latest bill ÷ 2 eyes × the days one lens lasts, from the
// day of the bill), with the reminder ready on WhatsApp; and free trials,
// given from stock with their batch, converted when the customer pays for
// lenses of the same product, or marked lapsed.

const TRIAL_STATES = { given: { label: "On trial", tone: "info" }, converted: { label: "Bought", tone: "success" }, lapsed: { label: "Lapsed", tone: "neutral" } };

export default function ContactLensesPage() {
  const biz = useOpenBusiness();
  const [view, setView] = useState("due");
  return (
    <div className="stack">
      <BusinessHeader icon="eye" title="Contact lenses"
        description="Customers whose contact lenses are running out, worked out from their latest bill: the lenses bought ÷ 2 eyes × the days one lens lasts. And the free trials given, until the customer buys or the trial lapses." />
      <div><Segmented label="Show" options={[{ value: "due", label: "Running out" }, { value: "trials", label: "Free trials" }]} value={view} onChange={setView} /></div>
      {view === "due" ? <DueList biz={biz} /> : <Trials biz={biz} />}
    </div>
  );
}

function DueList({ biz }) {
  const navigate = useNavigate();
  const [dueOnly, setDueOnly] = useState(true);
  const list = useServerList("optical/contact-lenses/due", { gridId: "optical-lens-due", params: dueOnly ? { due: "true" } : {} });
  const privacy = useShopPrivacy();
  const gate = useConsentGate(privacy);
  const record = (row, channel) => businessWrite(biz.id, `optical/contact-lenses/${row.contact_id}/reminders`, { channel })
    .then(() => { toast.success(`Reminder to ${row.name} noted.`); list.reload(); })
    .catch((err) => toast.error(getErrorMessage(err)));
  const remind = async (row) => {
    if (!(await gate.ensure("reminders", { id: row.contact_id, name: row.name }))) return;
    if (row.phone) window.open(lensDueLink(biz, row), "_blank", "noopener");
    record(row, "whatsapp");
  };
  const columns = useMemo(() => [
    { key: "name", header: "Customer", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <button type="button" className="link-button bz-link-left" onClick={() => navigate(biz.path(`prescriptions/${r.contact_id}`))}>{r.name}</button> },
    { key: "phone", header: "Phone", value: (r) => r.phone || "", mobile: "subtitle", render: (r) => r.phone || <span className="muted">No phone</span> },
    { key: "sold_on", header: "Last bought", type: "date", value: (r) => r.sold_on,
      render: (r) => <span className="bz-two-line"><span>{dateShort(r.sold_on, { year: true })}</span><small className="muted mono">{r.document_no}</small></span> },
    { key: "items", header: "Lenses", value: (r) => r.items, render: (r) => <span className="bz-two-line"><span>{r.items}</span><small className="muted">{Number(r.lenses)} lenses, each {r.days === 1 ? "a day" : `${r.days} days`}</small></span> },
    { key: "due_on", header: "Run out", type: "date", value: (r) => r.due_on, mobile: "show",
      render: (r) => <span className={`bz-two-line ${r.run_out ? "bz-minus" : ""}`}><span>{dateShort(r.due_on, { year: true })}</span><small className="muted">{Number(r.days_left) === 0 ? "today" : r.run_out ? `${-r.days_left} days ago` : `in ${r.days_left} days`}</small></span> },
    { key: "reminded_at", header: "Reminded", type: "date", value: (r) => r.reminded_at, render: (r) => (r.reminded_at ? dateShort(r.reminded_at) : <span className="muted">Not yet</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {r.phone && <button type="button" className="chip-button" onClick={() => remind(r)}><Icon name="message" size={14} /> WhatsApp</button>}
        {r.phone && (
          <ConsentLink privacy={privacy} purpose="reminders" person={{ id: r.contact_id, name: r.name }} href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}
            onSent={() => record(r, "call")}><Icon name="phone" size={14} /> Call</ConsentLink>
        )}
      </span>
    ) },
  ], [biz, navigate]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="bell" title={dueOnly ? "Running out within 14 days, or run out" : "Every customer's latest contact lenses"}>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Customer, phone, bill or lens" }} caption="Contact lenses running out" columns={columns}
          rowNoun={["customer", "customers"]}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> Only those running out</label>}
          rowClassName={(r) => (r.run_out ? "dg-tone-warning" : r.reminded_recently ? "dg-tone-muted" : "")}
          empty="Nobody's lenses are running out" emptyHint="A bill with contact lenses that say how often they are replaced shows here as they run out." emptyIcon="eye" />
      </SectionCard>
      {gate.dialog}
    </>
  );
}

function Trials({ biz }) {
  const [status, setStatus] = useState("given");
  const list = useServerList("optical/contact-lenses/trials", { gridId: "optical-lens-trials", params: status ? { status } : {} });
  const [giving, setGiving] = useState(false);
  const [lapsing, setLapsing] = useState(null);
  const canGive = biz.can("optical.create");
  const columns = useMemo(() => [
    { key: "customer_name", header: "Customer", value: (r) => r.customer_name, mobile: "title", pin: true },
    { key: "label", header: "Lens", value: (r) => r.label, mobile: "subtitle",
      render: (r) => <span className="bz-two-line"><span>{r.label}</span><small className="muted">{quantity(r.quantity, r.unit)}{r.lot_code ? ` · batch ${r.lot_code}` : ""}</small></span> },
    { key: "given_on", header: "Given", type: "date", value: (r) => r.given_on, render: (r) => <span className="bz-two-line"><span>{dateShort(r.given_on, { year: true })}</span><small className="muted">by {r.given_by_name}</small></span> },
    { key: "ends_on", header: "Trial ends", type: "date", value: (r) => r.ends_on, render: (r) => <span className={r.overdue ? "bz-minus" : ""}>{dateShort(r.ends_on, { year: true })}{r.overdue ? " · over" : ""}</span> },
    { key: "status", header: "Status", type: "status", value: (r) => TRIAL_STATES[r.status]?.label, mobile: "show",
      render: (r) => <span className="bz-two-line"><Badge tone={TRIAL_STATES[r.status]?.tone} label={TRIAL_STATES[r.status]?.label} />{r.document_no && <small className="muted mono">{r.document_no}</small>}{r.close_note && !r.document_no && <small className="muted">{r.close_note}</small>}</span> },
    canGive && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => r.status === "given" && (
      <span className="bz-row-actions"><button type="button" className="chip-button" onClick={() => setLapsing(r)}>Lapsed</button></span>
    ) },
  ].filter(Boolean), [canGive]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="gift" title="Free trials"
        actions={canGive && <button type="button" className="button" onClick={() => setGiving(true)}><Icon name="plus" size={16} /> Give a trial</button>}>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Customer, phone, lens or batch" }} caption="Free contact-lens trials" columns={columns}
          rowNoun={["trial", "trials"]}
          toolbar={(
            <label className="field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="given">On trial</option><option value="converted">Bought</option><option value="lapsed">Lapsed</option><option value="">All</option>
              </select>
            </label>
          )}
          rowClassName={(r) => (r.overdue ? "dg-tone-warning" : r.status !== "given" ? "dg-tone-muted" : "")}
          empty="No trials here" emptyHint={canGive ? "Give a customer lenses to try: they leave stock with their batch, and the trial converts when the customer buys." : undefined} emptyIcon="gift" />
      </SectionCard>
      {giving && <TrialDialog onClose={() => setGiving(false)} onSaved={(t) => { setGiving(false); toast.success(`Trial of ${t.label} given to ${t.customer_name}.`); list.reload(); }} />}
      {lapsing && (
        <ReasonDialog title={`${lapsing.customer_name}'s trial lapsed`} submitLabel="Mark it lapsed" label="Note (optional)" required={false} icon="x"
          description="The lenses given stay out of stock; the trial is closed without a sale." onClose={() => setLapsing(null)}
          onSubmit={(note) => businessWrite(biz.id, `optical/contact-lenses/trials/${lapsing.id}/close`, { outcome: "lapsed", note: note || undefined })}
          onSaved={() => { setLapsing(null); toast.success("Trial marked lapsed."); list.reload(); }} />
      )}
    </>
  );
}

// A free trial: the customer, the lens (a contact lens in stock here), its
// batch (the oldest unless named), how many and for how many days.
function TrialDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true"]);
  const lenses = useMemo(() => (options?.["catalog?active=true"] || []).filter(isContactLensItem), [options]);
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [lens, setLens] = useState(null);
  const [form, setForm] = useState({ locationId: String(locations[0]?.id || ""), lotCode: "", quantity: "1", days: "7", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Give a free trial" icon="gift" width={640} submitLabel="Give the trial" onClose={onClose} onSaved={onSaved} disabled={!options}
      description="The lenses leave stock now, with their batch, under the shop's MD-42 registration. The trial converts when the customer buys lenses of the same product."
      onSubmit={() => {
        if (!customer) throw new Error("Choose the customer");
        if (!lens) throw new Error("Choose the contact lens");
        return businessWrite(biz.id, "optical/contact-lenses/trials", { requestKey, contactId: customer.id, locationId: form.locationId, skuId: lens.id, lotCode: form.lotCode.trim() || undefined,
          quantity: form.quantity, days: form.days, notes: form.notes.trim() || undefined });
      }}>
      {error && <p className="field-wide bz-due small">{error}</p>}
      <div className="field-wide">
        <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2} required
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
      </div>
      <div className="field-wide">
        <SearchPicker label="Contact lens" placeholder="Name, power or code" value={lens} onChange={setLens} required options={lenses}
          getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.product_name || ""}`} getDescription={(s) => `${s.code} · ${quantity(s.stock, s.unit)} in stock`} />
      </div>
      {locations.length > 1 && <Field label="From"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      {lens?.tracking === "batch" && <Field label="Batch (optional)" hint="The oldest expiry first, unless named."><input maxLength={100} value={form.lotCode} onChange={set("lotCode")} className="mono" /></Field>}
      <Field label={`Quantity${lens ? ` (${lens.unit})` : ""}`}><input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={set("quantity")} /></Field>
      <Field label="Trial days"><input required type="number" min="1" max="60" step="1" value={form.days} onChange={set("days")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder="e.g. First time on monthly lenses" /></Field>
    </FormDialog>
  );
}
