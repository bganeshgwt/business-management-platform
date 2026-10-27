import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { downloadCsv } from "../../../../services/csv";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { dateTime, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { CONSIGNMENT_STATES, grams, purityMark, readHuids, readTags } from "./jewellery";
import { printConsignment } from "./jewelleryPrint";
import "../styles/jewellery.css";

// Hallmarking: gold and silver pieces sent to an assaying and hallmarking
// centre on a consignment (the centre's request form is HM/JWLR/F 1.3), at the
// centre until it comes back; then each piece hallmarked with its HUIDs, typed
// or scanned, or rejected, and the centre's charges posted as a purchase from
// it (each piece's charge is recovered on its bill). Pieces with the old
// hallmark (from before HUIDs) wait here to be re-hallmarked: where a HUID is
// needed they are not sold until they come back with one. The HUID list gives
// each HUID's status for Manak Online's HUID Transfer module; its file format
// was not checked, so the list is plain. Opened with ?send=<tags> or
// ?consignment=<id>.

const CHIPS = [["at_centre", "At the centre", { state: "at_centre" }], ["returned", "Back", { state: "returned" }], ["all", "All", {}]];
const optional = (value) => (String(value ?? "").trim() === "" ? undefined : String(value).trim());

function SendForm({ biz, tags, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [centre, setCentre] = useState(null);
  const [typed, setTyped] = useState(null);
  const [form, setForm] = useState({ tags: (tags || []).join(" "), requestRef: "", notes: "", locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, "jewellery/hallmarking", { requestKey, locationId: form.locationId, tags: readTags(form.tags), requestRef: optional(form.requestRef),
    notes: optional(form.notes), ...(centre ? { contactId: centre.id } : { centre: { name: typed?.name?.trim() || "", gstin: optional(typed?.gstin), phone: optional(typed?.phone) } }) });
  return (
    <FormDialog title="Send for hallmarking" icon="shield" width={760} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Make the consignment"
      successMessage={(h) => `Consignment ${h.consignment_no} made.`}
      description="Gold and silver pieces go to the centre and are not sold until they are back. Fill the centre's request form (HM/JWLR/F 1.3) from the printed list.">
      {typed ? (
        <>
          <Field label="Centre's name"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
          <Field label="GSTIN (optional)"><input className="mono" maxLength={15} value={typed.gstin} onChange={(e) => setTyped((c) => ({ ...c, gstin: e.target.value.toUpperCase() }))} /></Field>
          <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
          <div className="field-wide"><button type="button" className="link-button" onClick={() => setTyped(null)}>Choose the centre instead</button></div>
        </>
      ) : (
        <div className="field-wide jw-row">
          <div className="field jw-grow">
            <SearchPicker label="Assaying and hallmarking centre (a supplier)" placeholder="Name" value={centre} onChange={setCentre} minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "supplier", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
              getLabel={(x) => x.name} getDescription={(x) => x.gstin || ""} />
          </div>
          {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCentre(null); setTyped({ name: "", gstin: "", phone: "" }); }}><Icon name="plus" size={15} /> New centre</button>}
        </div>
      )}
      {locations.length > 1 && <Field label="From"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="The centre's request no. (optional)"><input maxLength={60} value={form.requestRef} onChange={set("requestRef")} /></Field>
      <Field label="Tags" wide hint="Scan or type each piece's tag, with spaces or new lines between them."><textarea required rows={4} className="mono" value={form.tags} onChange={set("tags")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function ReturnForm({ biz, consignment, onClose, onSaved }) {
  const costs = biz.can("purchasing.view");
  const [requestKey] = useState(newKey);
  const [lines, setLines] = useState(() => consignment.lines.map((l) => ({ tag: l.tag_no, description: l.description, mark: l.mark, result: "hallmarked", huids: "", charge: "" })));
  const [form, setForm] = useState({ billNo: "", billDate: "", gstRate: "18" });
  const setLine = (tag, change) => setLines((all) => all.map((l) => (l.tag === tag ? { ...l, ...change } : l)));
  const submit = () => businessWrite(biz.id, `jewellery/hallmarking/${consignment.id}/return`, { requestKey, centreBillNo: optional(form.billNo), centreBillDate: optional(form.billDate),
    gstRate: form.gstRate, lines: lines.map((l) => ({ tag: l.tag, result: l.result, huids: l.result === "hallmarked" ? readHuids(l.huids) : [], ...(costs && l.charge !== "" ? { charge: l.charge } : {}) })) });
  return (
    <FormDialog title={`Back from the centre: ${consignment.consignment_no}`} icon="shield" width={900} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Bring them back"
      successMessage="Back in stock."
      description="Each piece hallmarked with its HUIDs (a set may carry several), or rejected. The centre's charges are a purchase from it; a piece's charge is recovered on its bill.">
      <table className="jw-rates field-wide">
        <thead><tr><th scope="col">Piece</th><th scope="col">Came back</th><th scope="col">HUIDs</th>{costs && <th scope="col">Charge (₹)</th>}</tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.tag}>
            <th scope="row"><span className="mono">{l.tag}</span> <small className="muted">{l.description} · {l.mark}</small></th>
            <td><select aria-label={`${l.tag}: came back`} value={l.result} onChange={(e) => setLine(l.tag, { result: e.target.value })}><option value="hallmarked">Hallmarked</option><option value="rejected">Rejected</option></select></td>
            <td>{l.result === "hallmarked" ? <input aria-label={`${l.tag}: HUIDs`} required className="mono" value={l.huids} onChange={(e) => setLine(l.tag, { huids: e.target.value })} placeholder="AB12C3" /> : <span className="muted">—</span>}</td>
            {costs && <td><input aria-label={`${l.tag}: charge`} type="number" min="0" max="10000" step="0.01" value={l.charge} placeholder="Shop's charge" onChange={(e) => setLine(l.tag, { charge: e.target.value })} /></td>}
          </tr>
        ))}</tbody>
      </table>
      <Field label="The centre's bill no. (optional)"><input maxLength={60} value={form.billNo} onChange={(e) => setForm((f) => ({ ...f, billNo: e.target.value }))} /></Field>
      <Field label="Its date (optional)"><input type="date" value={form.billDate} onChange={(e) => setForm((f) => ({ ...f, billDate: e.target.value }))} /></Field>
      <Field label="GST on its bill"><select value={form.gstRate} onChange={(e) => setForm((f) => ({ ...f, gstRate: e.target.value }))}><option value="18">18%</option><option value="0">None</option></select></Field>
    </FormDialog>
  );
}

function ConsignmentPanel({ biz, consignmentId, onClose, onChanged }) {
  const [consignment, setConsignment] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/hallmarking/${consignmentId}`, undefined, controller.signal).then((h) => { setConsignment(h); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, consignmentId, version]);
  const back = consignment?.state === "returned";
  return (
    <SidePanel open title={consignment ? `Consignment ${consignment.consignment_no}` : "Consignment"} icon="shield" wide onClose={onClose}
      footer={consignment && (
        <div className="jw-panel-actions">
          {!back && biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => setReturning(true)}><Icon name="check" size={15} /> Back from the centre</button>}
          {biz.can("jewellery.print") && <button type="button" className="button button-secondary" onClick={() => printConsignment(biz, consignment)}><Icon name="print" size={15} /> Print the list</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!consignment ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head"><Badge tone={CONSIGNMENT_STATES[consignment.state]?.tone} label={CONSIGNMENT_STATES[consignment.state]?.label} /><strong>{consignment.centre_name}</strong></div>
          <dl className="jw-facts">
            {[["Sent", `${dateTime(consignment.created_at)} · ${consignment.by_name}`], ["Request no.", consignment.request_ref], ["Pieces", `${consignment.pieces} · ${grams(consignment.net_weight)} net`],
              ["Back", consignment.returned_at ? `${dateTime(consignment.returned_at)} · ${consignment.returned_by_name} · ${consignment.hallmarked} hallmarked, ${consignment.rejected} rejected` : null],
              ["Centre's bill", consignment.document_no ? `${consignment.document_no}${consignment.centre_bill_no ? ` (${consignment.centre_bill_no})` : ""}${consignment.charges_total ? ` · ${biz.exact(consignment.charges_total)}` : ""}` : null],
              ["Notes", consignment.notes]].filter(([, v]) => v).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">Tag</th><th scope="col">Piece</th><th scope="col">Purity</th><th scope="col">Net</th><th scope="col">Result</th></tr></thead>
            <tbody>{consignment.lines.map((l) => (
              <tr key={l.piece_id}><th scope="row" className="mono">{l.tag_no}</th><td>{l.description}{l.old_hallmark ? <small className="bz-minus"> · old hallmark</small> : null}</td><td>{l.mark}</td><td>{grams(l.net_weight)}</td>
                <td>{l.result === "out" ? "At the centre" : l.result === "hallmarked" ? `HUID ${(l.huids || []).join(", ")}${l.charge ? ` · ${biz.exact(l.charge)}` : ""}` : "Rejected"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {returning && <ReturnForm biz={biz} consignment={consignment} onClose={() => setReturning(false)} onSaved={() => { setReturning(false); setVersion((n) => n + 1); onChanged?.(); }} />}
    </SidePanel>
  );
}

// Every HUID with its piece and where it stands, as Manak Online's HUID Transfer module takes it (a plain list: its file format was not checked).
function HuidPanel({ biz, onClose }) {
  const [status, setStatus] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/hallmarking/huids", status ? { status } : undefined, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, status]);
  const download = () => downloadCsv([["HUID", "Tag", "Piece", "Purity", "Status", "Date", "Bill"], ...data.items.map((i) => [i.huid, i.tag, i.piece, i.purity, i.statusWords, i.day, i.documentNo || ""])],
    `huid-status-${status || "all"}.csv`);
  return (
    <SidePanel open title="HUID list" icon="shield" wide onClose={onClose} rule={data?.note}
      toolbar={<div className="jw-row"><Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>
        {(data?.statuses || []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        <button type="button" className="button button-secondary" disabled={!data?.items.length} onClick={download}><Icon name="download" size={15} /> Download CSV</button></div>}>
      <ErrorMessage message={error} />
      {!data ? !error && <Loading /> : data.items.length === 0 ? <p className="jw-note">No HUIDs here.</p> : (
        <table className="jw-rates">
          <thead><tr><th scope="col">HUID</th><th scope="col">Piece</th><th scope="col">Status</th><th scope="col">Since</th></tr></thead>
          <tbody>{data.items.map((i) => <tr key={i.huid}><th scope="row" className="mono">{i.huid}</th><td><span className="mono">{i.tag}</span> · {i.piece} · {i.purity}</td>
            <td>{i.statusWords}{i.documentNo ? <small className="muted"> · {i.documentNo}</small> : null}</td><td>{dateShort(i.day)}</td></tr>)}</tbody>
        </table>
      )}
    </SidePanel>
  );
}

export default function HallmarkingPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [chip, setChip] = useState("at_centre");
  // Opened from a piece or an order (?send=<tags>) or on a consignment (?consignment=<id>).
  const [sending, setSending] = useState(() => (params.get("send") ? { tags: readTags(params.get("send")) } : null));
  const [openId, setOpenId] = useState(() => params.get("consignment"));
  const [huids, setHuids] = useState(false);
  const filter = useMemo(() => CHIPS.find(([value]) => value === chip)?.[2] || {}, [chip]);
  const list = useServerList("jewellery/hallmarking", { gridId: "jewellery-hallmarking", params: filter });
  const waiting = useServerList("jewellery/pieces", { gridId: "jewellery-rehallmark", params: { old_hallmark: "true", stage: "in" } });
  const many = biz.locations.length > 1;
  const costs = biz.can("purchasing.view");
  useEffect(() => {
    if (params.get("send") || params.get("consignment")) setParams((p) => { const next = new URLSearchParams(p); next.delete("send"); next.delete("consignment"); return next; }, { replace: true });
  }, [params, setParams]);
  const columns = useMemo(() => [
    { key: "consignment_no", header: "Consignment", value: (h) => h.consignment_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Sent", type: "datetime", value: (h) => h.created_at },
    { key: "centre", header: "Centre", value: (h) => h.centre_name, mobile: "subtitle" },
    { key: "pieces", header: "Pieces", value: (h) => h.pieces, render: (h) => (h.state === "returned" ? `${h.pieces} · ${h.hallmarked} hallmarked${h.rejected ? `, ${h.rejected} rejected` : ""}` : String(h.pieces)), mobile: "show" },
    { key: "net_weight", header: "Net", value: (h) => Number(h.net_weight), render: (h) => grams(h.net_weight), total: "sum" },
    costs && { key: "charges", header: "Charges", type: "money", exact: true, value: (h) => Number(h.charges_total || 0), total: "sum" },
    { key: "state", header: "State", type: "status", value: (h) => CONSIGNMENT_STATES[h.state]?.label || h.state, render: (h) => <Badge tone={CONSIGNMENT_STATES[h.state]?.tone} label={CONSIGNMENT_STATES[h.state]?.label || h.state} /> },
    { key: "location", header: "Location", value: (h) => h.location_name, defaultHidden: !many },
  ].filter(Boolean), [costs, many]);
  const waitingColumns = useMemo(() => [
    { key: "tag_no", header: "Tag", value: (p) => p.tag_no, className: "mono", mobile: "title" },
    { key: "piece", header: "Piece", value: (p) => p.description || p.item_label, mobile: "subtitle" },
    { key: "purity", header: "Purity", value: (p) => purityMark(p.metal, p.purity) },
    { key: "gross", header: "Gross", value: (p) => Number(p.gross_weight), render: (p) => grams(p.gross_weight) },
    { key: "where", header: "Where", value: (p) => p.with_whom || p.location_name || "" },
  ], []);
  const waitingRows = waiting.data?.items || [];
  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Hallmarking"
        description="Pieces sent to an assaying and hallmarking centre and back with each piece's HUID; the centre's charges are a purchase, recovered on each piece's bill."
        primary={biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => setSending({ tags: [] })}><Icon name="shield" size={16} /> Send for hallmarking</button>}
        secondary={biz.can("jewellery.export") && <button type="button" className="button button-secondary" onClick={() => setHuids(true)}><Icon name="list" size={15} /> HUID list</button>} />
      <ErrorMessage message={list.error || waiting.error} />
      <SectionCard flush icon="shield" title="Consignments">
        <div className="fe-chips" role="group" aria-label="Consignments">
          {CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Consignment, centre, request or tag" }} caption="Hallmarking consignments" columns={columns}
          rowNoun={["consignment", "consignments"]} onRowClick={(h) => setOpenId(h.id)} empty="No consignments here" emptyIcon="shield" />
      </SectionCard>
      <SectionCard flush icon="alert" title="Waiting to be re-hallmarked"
        description="Pieces with the old hallmark, from before HUIDs. Where a HUID is needed they are not sold until they come back from the centre with one."
        actions={waitingRows.some((p) => p.status === "in_stock") && biz.can("jewellery.edit") && (
          <button type="button" className="button button-secondary" onClick={() => setSending({ tags: waitingRows.filter((p) => p.status === "in_stock").map((p) => p.tag_no) })}>Send these</button>
        )}>
        <DataGrid {...waiting.gridProps} search={{ ...waiting.gridProps.search, placeholder: "Tag or item" }} caption="Pieces waiting to be re-hallmarked" columns={waitingColumns}
          rowNoun={["piece", "pieces"]} empty="No piece waits to be re-hallmarked" emptyIcon="check" />
      </SectionCard>
      {sending && <SendForm biz={biz} tags={sending.tags} onClose={() => setSending(null)} onSaved={(h) => { setSending(null); list.reload(); waiting.reload(); setOpenId(h.id); }} />}
      {openId && <ConsignmentPanel biz={biz} consignmentId={openId} onClose={() => setOpenId(null)} onChanged={() => { list.reload(); waiting.reload(); }} />}
      {huids && <HuidPanel biz={biz} onClose={() => setHuids(false)} />}
    </div>
  );
}
