import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { TAGS, seasonWord, tagWord } from "./agri";
import useConfirm from "../../../../hooks/useConfirm";
import "../styles/agri.css";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// Farmers & village dues: each farmer (a customer with their village,
// father's or husband's name, land, crops and Agri Stack Farmer ID; never an
// Aadhaar number), and what each village owes: the customers' balances as
// Udhaar shows them, what is overdue, and what is on season credit with the
// next harvest date one falls due. Payments are taken on Udhaar. Tagged
// buyers: customers who are pest-control operators or government bodies (who
// may buy a restricted-use pesticide) or bulk consumers (Form XIII).

const TABS = [{ value: "farmers", label: "Farmers" }, { value: "dues", label: "Village dues" }, { value: "buyers", label: "Tagged buyers" }];

export default function FarmersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "farmers";
  const [village, setVillage] = useState(params.get("village") || "");
  const [dueOnly, setDueOnly] = useState(false);
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && biz.can("agri.edit") ? {} : null));
  const [openId, setOpenId] = useState(null);
  const money = biz.can("sales.view") || biz.can("receivables.view");
  const list = useServerList("agri/farmers", { gridId: "agri-farmers", params: { ...(village ? { village } : {}), ...(dueOnly ? { has_due: "true" } : {}) } });
  // Every village a farmer is in, for the filter.
  const { options } = useOptions(["agri/farmers"]);
  const villages = useMemo(() => [...new Map((options?.["agri/farmers"] || []).map((f) => [f.village_key, f.village])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [options]);
  useEffect(() => {
    if (params.get("new") || params.get("village")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); next.delete("village"); return next; }, { replace: true });
  }, [params, setParams]);
  const showTab = (value) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", value); return next; }, { replace: true });

  const columns = useMemo(() => [
    { key: "name", header: "Farmer", value: (f) => f.name, mobile: "title", pin: true,
      render: (f) => <span className="bz-two-line"><button type="button" className="link-button bz-link-left" onClick={() => setOpenId(f.contact_id)}>{f.name}</button>{f.phone && <small className="muted">{f.phone}</small>}</span> },
    { key: "village", header: "Village", value: (f) => f.village, mobile: "subtitle" },
    { key: "relative_name", header: "Father's or husband's name", value: (f) => f.relative_name || "" },
    { key: "land_acres", header: "Land (acres)", type: "number", value: (f) => (f.land_acres === null ? null : Number(f.land_acres)) },
    { key: "crops", header: "Crops", value: (f) => f.crops || "" },
    { key: "farmer_id", header: "Farmer ID", value: (f) => f.farmer_id || "", className: "mono", defaultHidden: true },
    money && { key: "balance", header: "Owes", type: "money", exact: true, value: (f) => Number(f.balance), total: "sum", mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (f) => (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setOpenId(f.contact_id)}>{money ? "Dues" : "View"}</button>
        {biz.can("agri.edit") && <button type="button" className="chip-button" onClick={() => setEditing(f)}>Edit</button>}
      </span>
    ) },
  ].filter(Boolean), [biz, money]);

  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Farmers & village dues"
        description="Each farmer's village, family name, land and crops with their Agri Stack Farmer ID, and what each village owes, with season credit due at the harvest. Payments are taken on Udhaar."
        primary={biz.can("agri.edit") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="user-plus" size={16} /> Add a farmer</button>} />
      <ContentTabs label="Farmers" value={tab} options={TABS} onChange={showTab}>
        {tab === "farmers" ? (
          <>
            <ErrorMessage message={list.error} />
            <SectionCard flush icon="users" title="Farmers">
              <DataGrid {...list.gridProps} caption="Farmers" columns={columns} currency={biz.symbol} rowNoun={["farmer", "farmers"]}
                toolbar={(
                  <>
                    {villages.length > 0 && (
                      <label className="field">
                        <span>Village</span>
                        <select value={village} onChange={(e) => setVillage(e.target.value)}>
                          <option value="">Every village</option>
                          {villages.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                        </select>
                      </label>
                    )}
                    {money && <label className="checkbox bz-check"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> Owing only</label>}
                  </>
                )}
                exportName={biz.can("contacts.export") ? `${biz.business.code}-farmers` : undefined}
                empty="No farmers yet" emptyHint="Add a farmer, or give a customer their village and land with Add a farmer." emptyIcon="users" />
            </SectionCard>
          </>
        ) : tab === "dues" ? (
          <VillageDues money={money} onVillage={(key) => { setVillage(key || ""); setDueOnly(true); showTab("farmers"); }} />
        ) : <TaggedBuyers />}
      </ContentTabs>
      {editing && <FarmerDialog farmer={editing} villages={villages.map(([, name]) => name)} onClose={() => setEditing(null)}
        onSaved={(f) => { setEditing(null); toast.success(`${f.name}'s details saved.`); list.reload(); }} />}
      {openId && <FarmerDues contactId={openId} onClose={() => setOpenId(null)} onEdit={(f) => { setOpenId(null); setEditing(f); }} />}
    </div>
  );
}

function VillageDues({ money, onVillage }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!money) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "agri/village-dues", undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, money, version]);
  const columns = useMemo(() => [
    { key: "village", header: "Village", value: (r) => r.village || "No village given", mobile: "title", pin: true,
      render: (r) => (r.village_key ? <button type="button" className="link-button bz-link-left" onClick={() => onVillage(r.village_key)}>{r.village}</button> : <span className="muted">No farmer details</span>) },
    { key: "farmers", header: "Farmers", type: "number", value: (r) => r.farmers, total: "sum" },
    { key: "owing", header: "Owing", type: "number", value: (r) => r.owing, total: "sum" },
    { key: "owed", header: "Owed", type: "money", exact: true, value: (r) => Number(r.owed), total: "sum", mobile: "show" },
    { key: "overdue", header: "Overdue", type: "money", exact: true, value: (r) => Number(r.overdue), total: "sum" },
    { key: "season_due", header: "On season credit", type: "money", exact: true, value: (r) => Number(r.season_due), total: "sum" },
    { key: "next_harvest_due", header: "Next harvest due", type: "date", value: (r) => r.next_harvest_due,
      render: (r) => (r.next_harvest_due ? dateShort(r.next_harvest_due, { year: true }) : <span className="muted">—</span>), mobile: "subtitle" },
  ], [onVillage]);
  if (!money) {
    return <SectionCard icon="lock" title="Village dues"><p className="muted">Your role does not see customers' dues. Ask for a role that sees sales or udhaar.</p></SectionCard>;
  }
  const t = data?.totals;
  return (
    <>
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="wallet" tone="primary" label="Owed by farmers" money={t?.owed} loading={!t && !error} note={t ? `${t.owing} owing` : undefined} />
        <StatTile icon="alert" tone="warning" label="Overdue" money={t?.overdue} loading={!t && !error} note="past the date it fell due" />
        <StatTile icon="calendar" label="On season credit" money={t?.seasonDue} loading={!t && !error} note="due at the harvest" />
      </div>
      <SectionCard flush icon="map-pin" title="By village" actions={<Link className="button button-secondary button-sm" to={businessPath(biz.id, "udhaar")}><Icon name="wallet" size={14} /> Collect on Udhaar</Link>}>
        <DataGrid id="agri-village-dues" caption="Dues by village" columns={columns} rows={data?.rows || []} rowKey={(r) => r.village_key || "none"} loading={!data && !error}
          error={data ? "" : error} onRetry={() => setVersion((n) => n + 1)} currency={biz.symbol} rowNoun={["village", "villages"]}
          rowClassName={(r) => (Number(r.overdue) > 0.004 ? "dg-tone-warning" : "")}
          exportName={biz.can("receivables.export") ? `${biz.business.code}-village-dues` : undefined}
          empty="Nothing owed yet" emptyHint="Bills left on udhaar for farmers show here by their village." emptyIcon="map-pin" />
      </SectionCard>
    </>
  );
}

// Customers tagged as buyers: a pest-control operator or a government body
// (with the licence or order it buys under), who may buy a restricted-use
// pesticide, or a bulk consumer, whose insecticide purchases go in Form XIII.
// Tagging an operator or a government body is a manager's (agri.approve).
function TaggedBuyers() {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const [tag, setTag] = useState("");
  const [editing, setEditing] = useState(null);
  const list = useServerList("agri/buyer-tags", { gridId: "agri-buyer-tags", params: tag ? { tag } : {} });
  const { reload } = list;
  const may = (value) => biz.can(value === "bulk_consumer" ? "agri.edit" : "agri.approve");
  const canTag = TAGS.some((t) => may(t.value));
  const columns = useMemo(() => {
    const allowed = (value) => biz.can(value === "bulk_consumer" ? "agri.edit" : "agri.approve");
    async function switchOff(t) {
      if (!(await confirm({ title: `${t.name}: switch off the ${tagWord(t.tag).toLowerCase()} tag?`, message: "It is switched off from now on. Bills already made keep it.", confirmLabel: "Switch it off" }))) return;
      try {
        await businessWrite(biz.id, `agri/buyer-tags/${t.contact_id}`, { tag: t.tag, reference: t.reference, validUntil: t.valid_until, notes: t.notes, active: false }, "put");
        toast.success(`${t.name} is no longer tagged as a ${tagWord(t.tag).toLowerCase()}.`);
        reload();
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
    return [
      { key: "name", header: "Customer", value: (t) => t.name, mobile: "title", pin: true,
        render: (t) => <span className="bz-two-line"><span>{t.name}</span>{t.phone && <small className="muted">{t.phone}</small>}</span> },
      { key: "tag", header: "Tagged as", value: (t) => tagWord(t.tag), mobile: "subtitle",
        render: (t) => <span className="bz-inline">{tagWord(t.tag)}{!t.active ? <Badge tone="neutral" label="Switched off" /> : !t.in_force && <Badge tone="danger" label="Lapsed" />}</span> },
      { key: "reference", header: "Licence or order", value: (t) => t.reference || "", className: "mono" },
      { key: "valid_until", header: "Valid until", type: "date", value: (t) => t.valid_until,
        render: (t) => (t.valid_until ? dateShort(t.valid_until, { year: true }) : <span className="muted">No end date</span>) },
      { key: "notes", header: "Notes", value: (t) => t.notes || "", defaultHidden: true },
      { key: "updated_by_name", header: "Last changed by", value: (t) => t.updated_by_name || "", defaultHidden: true },
      { key: "actions", header: "", label: "Actions", type: "actions", render: (t) => allowed(t.tag) && (
        <span className="bz-row-actions">
          <button type="button" className="chip-button" onClick={() => setEditing(t)}>{t.active ? "Edit" : "Switch on"}</button>
          {t.active && <button type="button" className="chip-button" onClick={() => switchOff(t)}>Switch off</button>}
        </span>
      ) },
    ];
  }, [biz, confirm, reload]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="shield" title="Tagged buyers"
        actions={canTag && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={14} /> Tag a buyer</button>}>
        <DataGrid {...list.gridProps} caption="Tagged buyers" columns={columns} rowNoun={["tag", "tags"]}
          rowClassName={(t) => (t.active && !t.in_force ? "dg-tone-warning" : "")}
          toolbar={(
            <label className="field">
              <span>Tagged as</span>
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">Any tag</option>
                {TAGS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
          )}
          exportName={biz.can("contacts.export") ? `${biz.business.code}-tagged-buyers` : undefined}
          empty="No tagged buyers" emptyHint="Tag a pest-control operator or a government body before they buy a restricted-use pesticide, and a bulk consumer for Form XIII." emptyIcon="shield" />
      </SectionCard>
      {editing && <TagDialog tag={editing} may={may} onClose={() => setEditing(null)}
        onSaved={(t) => { setEditing(null); reload(); toast.success(`${t.name} is tagged as a ${tagWord(t.tag).toLowerCase()}.`); }} />}
    </>
  );
}

function TagDialog({ tag, may, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(tag.contact_id);
  const { options } = useOptions(editing ? [] : ["contacts?kind=customer&active=true"]);
  const allowed = TAGS.filter((t) => may(t.value));
  const [form, setForm] = useState({ contactId: "", tag: tag.tag || allowed[0]?.value || "", reference: tag.reference || "", validUntil: tag.valid_until || "", notes: tag.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const kind = TAGS.find((t) => t.value === form.tag);
  const submit = () => businessWrite(biz.id, `agri/buyer-tags/${editing ? tag.contact_id : form.contactId}`, { tag: form.tag, reference: form.reference.trim() || null,
    validUntil: form.validUntil || null, notes: form.notes.trim() || null, active: true }, "put");
  return (
    <FormDialog title={editing ? `${tag.name}: ${tagWord(tag.tag).toLowerCase()}` : "Tag a buyer"} icon="shield" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="A pest-control operator or a government body may buy a restricted-use pesticide while the tag is in force. A bulk consumer's insecticide purchases go in Form XIII.">
      {!editing && (
        <>
          <Field label="Customer" wide>
            <select required value={form.contactId} onChange={set("contactId")}>
              <option value="">Choose the customer…</option>
              {(options?.["contacts?kind=customer&active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Tagged as">
            <select value={form.tag} onChange={set("tag")}>{allowed.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
          </Field>
        </>
      )}
      <Field label={kind?.reference || "Reference"}>
        <input required={form.tag !== "bulk_consumer"} maxLength={80} className="mono" value={form.reference} onChange={set("reference")} />
      </Field>
      <Field label="Valid until (optional)" hint="The tag lapses after this date."><input type="date" value={form.validUntil} onChange={set("validUntil")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// A farmer's details and their bills still to collect, with each one's season and due date.
function FarmerDues({ contactId, onClose, onEdit }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [billId, setBillId] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `agri/farmers/${contactId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const f = data?.farmer;
  return (
    <>
      <Modal title={f ? f.name : "Loading…"} icon="user" width={820} onClose={() => { if (!billId) onClose(); }}
        description={f ? [f.village, f.phone].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack bz-detail">
            <dl className="agri-facts">
              <div><dt>Village</dt><dd>{f.village}</dd></div>
              {f.relative_name && <div><dt>Father's or husband's name</dt><dd>{f.relative_name}</dd></div>}
              {f.land_acres && <div><dt>Land</dt><dd>{Number(f.land_acres)} acres</dd></div>}
              {f.crops && <div><dt>Crops</dt><dd>{f.crops}</dd></div>}
              {f.farmer_id && <div><dt>Farmer ID</dt><dd className="mono">{f.farmer_id}</dd></div>}
            </dl>
            {data.money ? (
              <>
                <div className="bz-totals"><span className={Number(data.balance) > 0.004 ? "bz-due" : ""}>Owes <strong>{biz.exact(data.balance)}</strong></span></div>
                <DataGrid variant="compact" id="agri-farmer-bills" caption="Bills to collect" rows={data.bills} currency={biz.symbol} rowNoun={["bill", "bills"]}
                  empty="Nothing to collect" columns={[
                    { key: "document_no", header: "Bill", value: (b) => b.document_no, mobile: "title",
                      render: (b) => (biz.can("sales.view") ? <button type="button" className="link-button mono" onClick={() => setBillId(b.id)}>{b.document_no}</button> : b.document_no) },
                    { key: "created_at", header: "Billed", type: "date", value: (b) => b.created_at, mobile: "subtitle" },
                    { key: "season", header: "Season", value: (b) => seasonWord(b.season, b.season_year), render: (b) => seasonWord(b.season, b.season_year) || <span className="muted">—</span> },
                    { key: "due_on", header: "Due", type: "date", value: (b) => b.due_on,
                      render: (b) => <span className="bz-inline">{dateShort(b.due_on, { year: true })}{b.overdue && <Badge tone="danger" label="Overdue" />}</span> },
                    { key: "balance", header: "To collect", type: "money", exact: true, value: (b) => Number(b.balance), total: "sum", mobile: "show" },
                  ]} />
              </>
            ) : <p className="small muted">Your role does not see customers' dues.</p>}
            <div className="form-actions bz-start">
              {data.money && biz.can("receivables.view") && <Link className="button button-secondary" to={businessPath(biz.id, "udhaar")}><Icon name="wallet" size={15} /> Collect on Udhaar</Link>}
              {biz.can("agri.edit") && <button type="button" className="button button-secondary" onClick={() => onEdit(f)}><Icon name="edit" size={15} /> Change the details</button>}
            </div>
          </div>
        )}
      </Modal>
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => setVersion((n) => n + 1)} />}
    </>
  );
}

// A new farmer (a new customer, or a customer without farmer details), or a farmer's details changed.
function FarmerDialog({ farmer, villages, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(farmer.contact_id);
  const { options } = useOptions(editing ? [] : ["contacts?kind=customer&active=true", "agri/farmers"]);
  const known = new Set((options?.["agri/farmers"] || []).map((f) => String(f.contact_id)));
  const customers = (options?.["contacts?kind=customer&active=true"] || []).filter((c) => !known.has(String(c.id)));
  const canAddCustomer = biz.can("contacts.create");
  const [form, setForm] = useState({
    contactId: "", name: "", phone: "", village: farmer.village || "", relativeName: farmer.relative_name || "", landAcres: farmer.land_acres ? String(Number(farmer.land_acres)) : "",
    crops: farmer.crops || "", farmerId: farmer.farmer_id || "", notes: farmer.notes || "",
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => {
    const details = { village: form.village.trim(), relativeName: form.relativeName.trim() || null, landAcres: form.landAcres || null, crops: form.crops.trim() || null,
      farmerId: form.farmerId.trim() || null, notes: form.notes.trim() || null };
    if (editing) return businessWrite(biz.id, `agri/farmers/${farmer.contact_id}`, details, "put");
    return businessWrite(biz.id, "agri/farmers", form.contactId ? { ...details, contactId: form.contactId }
      : { ...details, name: form.name.trim(), phone: form.phone.trim() || null, consents: consentChanges(form.consents, []) || undefined });
  };
  return (
    <FormDialog title={editing ? `${farmer.name}'s details` : "Add a farmer"} icon="user-plus" width={640} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="No Aadhaar number is kept: the Farmer ID is the one the Agri Stack farmer registry gives.">
      {!editing && (
        <Field label="Customer" wide hint={canAddCustomer ? undefined : "Your role adds farmer details to customers already saved."}>
          <select value={form.contactId} onChange={set("contactId")} required={!canAddCustomer}>
            {canAddCustomer && <option value="">A new customer</option>}
            {!canAddCustomer && <option value="">Choose the customer…</option>}
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
          </select>
        </Field>
      )}
      {!editing && !form.contactId && canAddCustomer && (
        <>
          <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          <Field label="Phone (optional)"><input maxLength={30} inputMode="tel" value={form.phone} onChange={set("phone")} /></Field>
          <NewCustomerConsents value={form.consents} onChange={(consents) => setForm((f) => ({ ...f, consents }))} />
        </>
      )}
      <Field label="Village">
        <input required maxLength={100} list="agri-villages" value={form.village} onChange={set("village")} />
        <datalist id="agri-villages">{villages.map((v) => <option key={v} value={v} />)}</datalist>
      </Field>
      <Field label="Father's or husband's name (optional)"><input maxLength={150} value={form.relativeName} onChange={set("relativeName")} /></Field>
      <Field label="Land in acres (optional)"><input type="number" min="0.01" step="0.01" inputMode="decimal" value={form.landAcres} onChange={set("landAcres")} /></Field>
      <Field label="Crops (optional)"><input maxLength={200} value={form.crops} onChange={set("crops")} placeholder="e.g. Paddy, cotton, chilli" /></Field>
      <Field label="Farmer ID (optional)" hint="From the Agri Stack farmer registry. Never type an Aadhaar number here.">
        <input maxLength={30} className="mono" value={form.farmerId} onChange={set("farmerId")} />
      </Field>
      <Field label="Notes (optional)"><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}
