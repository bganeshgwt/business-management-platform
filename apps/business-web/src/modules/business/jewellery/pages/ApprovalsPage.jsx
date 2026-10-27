import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, dateTime, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { APPROVAL_STATES, grams, readTags } from "./jewellery";
import { printApprovalChallan } from "./jewelleryPrint";
import { whatsappLink } from "../../retail/pages/retail";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import ConsentLink from "../../../personal-data/components/ConsentLink";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import { consentChanges } from "../../../personal-data/personalData";
import "../styles/jewellery.css";

// Approvals (jangad): pieces lent to a customer to choose from at home, or to
// another jeweller for its counter, on a numbered challan with the day they
// are due back. Out on approval a piece stays the shop's stock and is never
// sold to anyone else. They come back in part or all at once, or are sold
// from the challan on a jewellery bill to the challan's customer. Each
// challan shows how many days its pieces have been out, and those past their
// day are listed for a reminder. Opened with ?send=<tags> from Pieces & tags,
// or ?challan=<id> on a challan.

const CHIPS = [["out", "Out", { state: "out" }], ["overdue", "Past their day", { state: "overdue" }], ["closed", "Closed", { state: "closed" }], ["all", "All", {}]];
const PARTIES = [{ value: "customer", label: "A customer, to choose at home" }, { value: "jeweller", label: "Another jeweller, for its counter" }];

function SendForm({ biz, tags, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [party, setParty] = useState(null);
  const [typed, setTyped] = useState(null);
  const [form, setForm] = useState({ kind: "customer", dueOn: businessToday(biz.business.timezone), tags: (tags || []).join(" "), notes: "",
    locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, "jewellery/approvals", { requestKey, locationId: form.locationId, party: form.kind, dueOn: form.dueOn, tags: readTags(form.tags),
    notes: form.notes.trim() || undefined, ...(party ? { contactId: party.id } : { customer: { name: typed?.name?.trim() || "", phone: typed?.phone?.trim() || undefined,
      gstin: typed?.gstin?.trim() || undefined, consents: consentChanges(typed?.consents, []) || undefined } }) });
  return (
    <FormDialog title="Send on approval" icon="clipboard" width={760} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Make the challan"
      successMessage={(a) => `Approval challan ${a.approval_no} made.`}
      description="The pieces stay the shop's stock and are not sold to anyone else while they are out. They come back on the challan, or are sold from it on a jewellery bill.">
      <Field label="Who takes them"><select value={form.kind} onChange={set("kind")}>{PARTIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
      {typed ? (
        <>
          <Field label="Name"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
          <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
          {form.kind === "jeweller" && <Field label="GSTIN (optional)"><input className="mono" maxLength={15} value={typed.gstin} onChange={(e) => setTyped((c) => ({ ...c, gstin: e.target.value.toUpperCase() }))} /></Field>}
          <NewCustomerConsents value={typed.consents} onChange={(consents) => setTyped((c) => ({ ...c, consents }))} />
          <div className="field-wide"><button type="button" className="link-button" onClick={() => setTyped(null)}>Find them instead</button></div>
        </>
      ) : (
        <div className="field-wide jw-row">
          <div className="field jw-grow">
            <SearchPicker label={form.kind === "jeweller" ? "Jeweller (a customer)" : "Customer"} placeholder="Name or phone" value={party} onChange={setParty} minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
              getLabel={(x) => x.name} getDescription={(x) => [x.phone, x.gstin].filter(Boolean).join(" · ")} />
          </div>
          {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setParty(null); setTyped({ name: "", phone: "", gstin: "" }); }}><Icon name="user-plus" size={15} /> New</button>}
        </div>
      )}
      {locations.length > 1 && <Field label="From"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Due back"><input required type="date" min={businessToday(biz.business.timezone)} value={form.dueOn} onChange={set("dueOn")} /></Field>
      <Field label="Tags" wide hint="Scan or type each piece's tag, with spaces or new lines between them."><textarea required rows={3} className="mono" value={form.tags} onChange={set("tags")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function TakeBackForm({ biz, approval, onClose, onSaved }) {
  const out = approval.lines.filter((l) => l.outcome === "out");
  const [requestKey] = useState(newKey);
  const [chosen, setChosen] = useState(() => out.map((l) => l.tag_no));
  const [note, setNote] = useState("");
  const toggle = (tag) => setChosen((all) => (all.includes(tag) ? all.filter((t) => t !== tag) : [...all, tag]));
  return (
    <FormDialog title={`Back from approval ${approval.approval_no}`} icon="undo" onClose={onClose} onSaved={onSaved} submitLabel="Take them back" successMessage="Back in stock."
      onSubmit={() => businessWrite(biz.id, `jewellery/approvals/${approval.id}/returns`, { requestKey, tags: chosen, note: note.trim() || undefined })}
      description="The pieces brought back go into stock; the rest stay out on the challan.">
      <ul className="field-wide jw-og-choices">{out.map((l) => (
        <li key={l.tag_no}><label className="checkbox bz-check"><input type="checkbox" checked={chosen.includes(l.tag_no)} onChange={() => toggle(l.tag_no)} />
          <span><span className="mono">{l.tag_no}</span> · {l.description} · {grams(l.net_weight)}</span></label></li>
      ))}</ul>
      <Field label="Note (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  );
}

function ApprovalPanel({ biz, approvalId, onClose, onChanged }) {
  const [approval, setApproval] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [taking, setTaking] = useState(false);
  const privacy = useShopPrivacy();
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/approvals/${approvalId}`, undefined, controller.signal).then((a) => { setApproval(a); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, approvalId, version]);
  const out = approval ? approval.lines.filter((l) => l.outcome === "out") : [];
  const shop = biz.settings.display_name || biz.business.name;
  const reminder = approval && approval.party_phone ? whatsappLink(approval.party_phone, `${shop}: Dear ${approval.party_name}, the ${out.length === 1 ? "piece" : `${out.length} pieces`} you took on approval (${approval.approval_no}) ${approval.state === "overdue" ? "were" : "are"} due back on ${dateShort(approval.due_on, { year: true })}. Please let us know which you would like to keep.`) : null;
  return (
    <SidePanel open title={approval ? `Approval ${approval.approval_no}` : "Approval challan"} icon="clipboard" wide onClose={onClose}
      footer={approval && (
        <div className="jw-panel-actions">
          {out.length > 0 && biz.can("jewellery.create") && <Link className="button" to={`${biz.path("jewellery-bill")}?approval=${approval.id}&tags=${out.map((l) => l.tag_no).join(",")}`}><Icon name="receipt" size={15} /> Bill what they keep</Link>}
          {out.length > 0 && biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => setTaking(true)}><Icon name="undo" size={15} /> Take back</button>}
          {out.length > 0 && reminder && <ConsentLink privacy={privacy} purpose="reminders" person={{ id: approval.contact_id, name: approval.party_name }} href={reminder} className="button button-secondary"><Icon name="message" size={15} /> Remind</ConsentLink>}
          {biz.can("jewellery.print") && <button type="button" className="button button-secondary" onClick={() => printApprovalChallan(biz, approval)}><Icon name="print" size={15} /> Print the challan</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!approval ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head">
            <Badge tone={APPROVAL_STATES[approval.state]?.tone} label={APPROVAL_STATES[approval.state]?.label || approval.state} />
            <strong>{approval.party_name}</strong><span className="muted">{approval.party_words}</span>
          </div>
          <dl className="jw-facts">
            {[["Sent", `${dateTime(approval.created_at)} · ${approval.by_name}`], ["Due back", dateShort(approval.due_on, { year: true })],
              ["Out for", `${approval.days_out} ${approval.days_out === 1 ? "day" : "days"}`], ["Pieces", `${approval.pieces} · ${approval.pieces_out} out · ${approval.pieces_sold} sold`],
              ["Phone", approval.party_phone], ["GSTIN", approval.party_gstin], ["Notes", approval.notes]].filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">Tag</th><th scope="col">Piece</th><th scope="col">Purity</th><th scope="col">Net</th><th scope="col">Now</th></tr></thead>
            <tbody>{approval.lines.map((l) => (
              <tr key={l.tag_no}><th scope="row" className="mono">{l.tag_no}</th><td>{l.description}{l.huid ? <small className="muted"> · HUID {l.huid}</small> : null}</td><td>{l.mark}</td><td>{grams(l.net_weight)}</td>
                <td>{l.outcome === "out" ? "Out" : l.outcome === "sold" ? `Sold${l.document_no ? ` · ${l.document_no}` : ""}` : `Back · ${dateTime(l.closed_at)}`}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted small">{approval.gst_note}</p>
        </div>
      )}
      {taking && <TakeBackForm biz={biz} approval={approval} onClose={() => setTaking(false)} onSaved={() => { setTaking(false); setVersion((n) => n + 1); onChanged?.(); }} />}
    </SidePanel>
  );
}

export default function ApprovalsPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [chip, setChip] = useState("out");
  // Opened from Pieces & tags (?send=<tags>) or on a challan (?challan=<id>).
  const [sending, setSending] = useState(() => (params.get("send") ? { tags: readTags(params.get("send")) } : null));
  const [openId, setOpenId] = useState(() => params.get("challan"));
  const filter = useMemo(() => CHIPS.find(([value]) => value === chip)?.[2] || {}, [chip]);
  const list = useServerList("jewellery/approvals", { gridId: "jewellery-approvals", params: filter });
  const many = biz.locations.length > 1;
  useEffect(() => {
    if (params.get("send") || params.get("challan")) setParams((p) => { const next = new URLSearchParams(p); next.delete("send"); next.delete("challan"); return next; }, { replace: true });
  }, [params, setParams]);
  const columns = useMemo(() => [
    { key: "approval_no", header: "Challan", value: (a) => a.approval_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Sent", type: "datetime", value: (a) => a.created_at },
    { key: "party", header: "With", value: (a) => `${a.party_name} ${a.party_phone || ""}`, mobile: "subtitle",
      render: (a) => <span className="bz-two-line"><span>{a.party_name}</span><small className="muted">{a.party === "jeweller" ? "Jeweller" : "Customer"}{a.party_phone ? ` · ${a.party_phone}` : ""}</small></span> },
    { key: "pieces", header: "Pieces out", value: (a) => a.pieces_out, render: (a) => `${a.pieces_out} of ${a.pieces}`, mobile: "show" },
    { key: "net_out", header: "Net out", value: (a) => Number(a.net_out), render: (a) => grams(a.net_out), total: "sum" },
    { key: "due_on", header: "Due back", value: (a) => a.due_on, render: (a) => <span className={a.state === "overdue" ? "bz-due" : ""}>{dateShort(a.due_on)}</span> },
    { key: "days_out", header: "Days out", value: (a) => a.days_out },
    { key: "state", header: "State", type: "status", value: (a) => APPROVAL_STATES[a.state]?.label || a.state, render: (a) => <Badge tone={APPROVAL_STATES[a.state]?.tone} label={APPROVAL_STATES[a.state]?.label || a.state} /> },
    { key: "location", header: "Location", value: (a) => a.location_name, defaultHidden: !many },
  ], [many]);
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Approvals"
        description="Pieces out on approval (jangad) to customers and other jewellers: never sold to anyone else while out, back in part or all, or sold from the challan on a jewellery bill."
        primary={biz.can("jewellery.edit") && biz.can("sales.view") && <button type="button" className="button" onClick={() => setSending({ tags: [] })}><Icon name="plus" size={16} /> Send on approval</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="clipboard" title="Approval challans" description="The GST time limit for goods sent on approval was not checked: the days out are shown, and no limit is enforced.">
        <div className="fe-chips" role="group" aria-label="Approval challans">
          {CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Challan, name, phone or tag" }} caption="Approval challans" columns={columns}
          rowNoun={["challan", "challans"]} onRowClick={(a) => setOpenId(a.id)} rowClassName={(a) => (a.state === "overdue" ? "dg-tone-danger" : a.state === "closed" ? "dg-tone-muted" : "")}
          empty="No approval challans here" emptyIcon="clipboard" />
      </SectionCard>
      {sending && <SendForm biz={biz} tags={sending.tags} onClose={() => setSending(null)} onSaved={(a) => { setSending(null); list.reload(); setOpenId(a.id); }} />}
      {openId && <ApprovalPanel biz={biz} approvalId={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </div>
  );
}
