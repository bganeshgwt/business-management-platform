import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { grams, karigarHeldWords } from "./jewellery";
import { IssueForm, IssuePanel, Itc04Panel, KarigarBadge, KarigarForm, KarigarPanel, ReceiptPanel, ReceiveForm } from "./KarigarDialogs";
import "../styles/jewellery.css";

// Karigar work: the goldsmiths the shop gives job work to. Metal, pieces to
// repair and stones go out on an issue challan; pieces made, pieces repaired,
// scrap and stones come back on a receipt, the pieces made tagged into stock
// as they come in. Each karigar's account of metal is kept in fine weight by
// purity (issued, back, the wastage allowed and the actual), their labour is
// billed on their invoice (a purchase at 5% GST, 1.5% for diamond work, none
// from one not registered), and the challans give the ITC-04 data. Pieces at
// a karigar are not sold until they are back. Labour and money show to those
// who see purchases.
// Opened with ?issue=<tag> (a piece sent from its panel), ?order=<id> (an
// order's work) or ?receive=<issue id> (a challan's pieces back).

const ISSUE_CHIPS = [["all", "All", {}], ["overdue", "Past the day due", { overdue: "true" }]];
const RECEIPT_CHIPS = [["all", "All", {}], ["to_bill", "Labour to invoice", { to_bill: "true" }]];

export default function KarigarWorkPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [karigars, setKarigars] = useState(null);
  const [items, setItems] = useState([]);
  const [costs, setCosts] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  // Opened from a piece (?issue=<tag>), an order (?order=<id>) or a challan (?receive=<issue id>).
  const [dialog, setDialog] = useState(() => {
    const tag = params.get("issue"), order = params.get("order"), receive = params.get("receive");
    return tag ? { kind: "issue", preset: { tags: [tag] } } : order ? { kind: "issue", preset: { orderId: order } } : receive ? { kind: "receive", preset: { issueId: receive } } : null;
  });
  const [panel, setPanel] = useState(null);
  const [issueChip, setIssueChip] = useState("all");
  const [receiptChip, setReceiptChip] = useState("all");
  const issueParams = useMemo(() => ISSUE_CHIPS.find(([value]) => value === issueChip)?.[2] || {}, [issueChip]);
  const receiptParams = useMemo(() => RECEIPT_CHIPS.find(([value]) => value === receiptChip)?.[2] || {}, [receiptChip]);
  const issues = useServerList("jewellery/karigars/issues", { gridId: "jewellery-karigar-issues", params: issueParams });
  const receipts = useServerList("jewellery/karigars/receipts", { gridId: "jewellery-karigar-receipts", params: receiptParams });
  const many = biz.locations.length > 1;
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "jewellery/karigars", undefined, controller.signal), businessRead(biz.id, "jewellery/items", undefined, controller.signal)])
      .then(([k, i]) => { setKarigars(k.items); setCosts(k.costs); setItems(i.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  useEffect(() => {
    if (params.get("issue") || params.get("order") || params.get("receive")) {
      setParams((p) => { const next = new URLSearchParams(p); for (const name of ["issue", "order", "receive"]) next.delete(name); return next; }, { replace: true });
    }
  }, [params, setParams]);
  const reload = useCallback(() => { setVersion((n) => n + 1); issues.reload(); receipts.reload(); }, [issues, receipts]);
  const saved = (next) => { setDialog(null); reload(); if (next) setPanel(next); };

  const issueColumns = useMemo(() => [
    { key: "issue_no", header: "Challan", value: (i) => i.issue_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Made", type: "datetime", value: (i) => i.created_at },
    { key: "karigar", header: "Karigar", value: (i) => i.karigar_name, mobile: "subtitle" },
    { key: "order", header: "Order", value: (i) => i.order_no || "", render: (i) => i.order_no || <span className="muted">The shop's own</span> },
    { key: "metal", header: "Metal", value: (i) => Number(i.metal_net), render: (i) => (Number(i.metal_net) ? `${grams(i.metal_net)} · ${grams(i.metal_fine)} fine` : "—") },
    { key: "pieces", header: "Pieces out", value: (i) => i.pieces_out, render: (i) => (i.pieces ? `${i.pieces_out} of ${i.pieces}` : "—"), mobile: "show" },
    { key: "due", header: "Due back", value: (i) => i.due_on || "",
      render: (i) => (i.due_on ? <span className={i.overdue ? "bz-due" : ""}>{dateShort(i.due_on)}{i.overdue ? " · past its day" : ""}</span> : <span className="muted">—</span>) },
    { key: "location", header: "Location", value: (i) => i.location_name, defaultHidden: !many },
  ], [many]);
  const receiptColumns = useMemo(() => [
    { key: "receipt_no", header: "Receipt", value: (r) => r.receipt_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Made", type: "datetime", value: (r) => r.created_at },
    { key: "karigar", header: "Karigar", value: (r) => r.karigar_name, mobile: "subtitle" },
    { key: "issue", header: "Against", value: (r) => r.issue_no || "", render: (r) => r.issue_no || <span className="muted">Running account</span> },
    { key: "made", header: "Made · repaired", value: (r) => r.made + r.repaired, render: (r) => `${r.made} · ${r.repaired}` },
    costs && { key: "labour", header: "Labour", type: "money", exact: true, value: (r) => Number(r.labour), total: "sum" },
    costs && { key: "unbilled", header: "To invoice", type: "money", exact: true, value: (r) => Number(r.unbilled), total: "sum", mobile: "show" },
    { key: "location", header: "Location", value: (r) => r.location_name, defaultHidden: !many },
  ].filter(Boolean), [costs, many]);

  if (!karigars) return <div className="stack"><BusinessHeader icon="truck" title="Karigar work" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Karigar work"
        description="Metal, pieces and stones out to karigars on issue challans and back on their receipts, each karigar's metal kept in fine weight by purity, and their labour invoiced."
        primary={biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => setDialog({ kind: "issue", preset: {} })}><Icon name="truck" size={16} /> Issue to a karigar</button>}
        secondary={<>
          {biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "receive", preset: {} })}>Receive from a karigar</button>}
          {biz.can("jewellery.export") && <button type="button" className="button button-secondary" onClick={() => setPanel({ kind: "itc04" })}><Icon name="file" size={15} /> ITC-04 data</button>}
        </>} />
      <ErrorMessage message={error || issues.error || receipts.error} />
      <SectionCard icon="users" title="Karigars" description="Each karigar's metal in fine weight, and the labour not invoiced yet."
        actions={biz.can("jewellery.approve") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "karigar" })}><Icon name="plus" size={15} /> A karigar</button>}>
        {karigars.length === 0 ? <p className="jw-note">No karigars yet: make one of the suppliers a karigar, with the wastage allowed on their work.</p> : (
          <table className="jw-rates">
            <thead><tr><th scope="col">Karigar</th><th scope="col">GST</th><th scope="col">Wastage allowed</th><th scope="col">Pieces with them</th><th scope="col">Metal with them (fine)</th>{costs && <th scope="col">Labour to invoice</th>}</tr></thead>
            <tbody>{karigars.map((k) => (
              <tr key={k.contact_id} className={k.active ? "" : "muted"}>
                <th scope="row"><button type="button" className="link-button" onClick={() => setPanel({ kind: "karigar", id: k.contact_id })}>{k.name}</button>{k.phone ? <small className="muted"> · {k.phone}</small> : null}</th>
                <td><KarigarBadge karigar={k} /></td><td>{Number(k.wastage_percent)}%</td><td>{k.pieces_held || "—"}</td><td>{karigarHeldWords(k)}</td>
                {costs && <td>{Number(k.unbilled) ? biz.exact(k.unbilled) : "—"}</td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </SectionCard>
      <SectionCard flush icon="truck" title="Issue challans">
        <div className="fe-chips" role="group" aria-label="Issue challans">
          {ISSUE_CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={issueChip === value} className={`fe-chip ${issueChip === value ? "is-active" : ""}`} onClick={() => setIssueChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...issues.gridProps} search={{ ...issues.gridProps.search, placeholder: "Challan, karigar or order" }} caption="Issue challans" columns={issueColumns}
          rowNoun={["challan", "challans"]} onRowClick={(i) => setPanel({ kind: "issue", id: i.id })} rowClassName={(i) => (i.overdue ? "dg-tone-danger" : "")}
          empty="No issue challans here" emptyIcon="truck" />
      </SectionCard>
      <SectionCard flush icon="check" title="Receipts">
        <div className="fe-chips" role="group" aria-label="Receipts">
          {RECEIPT_CHIPS.filter(([value]) => costs || value !== "to_bill").map(([value, label]) => <button key={value} type="button" aria-pressed={receiptChip === value} className={`fe-chip ${receiptChip === value ? "is-active" : ""}`} onClick={() => setReceiptChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...receipts.gridProps} search={{ ...receipts.gridProps.search, placeholder: "Receipt, karigar or challan" }} caption="Receipts" columns={receiptColumns}
          rowNoun={["receipt", "receipts"]} onRowClick={(r) => setPanel({ kind: "receipt", id: r.id })} empty="No receipts here" emptyIcon="check" />
      </SectionCard>
      {dialog?.kind === "karigar" && <KarigarForm biz={biz} onClose={() => setDialog(null)} onSaved={(k) => saved({ kind: "karigar", id: k.contact_id })} />}
      {dialog?.kind === "issue" && <IssueForm biz={biz} karigars={karigars} preset={dialog.preset} onClose={() => setDialog(null)} onSaved={(i) => saved({ kind: "issue", id: i.id })} />}
      {dialog?.kind === "receive" && <ReceiveForm biz={biz} karigars={karigars} items={items} preset={dialog.preset} onClose={() => setDialog(null)} onSaved={(r) => saved({ kind: "receipt", id: r.id })} />}
      {panel?.kind === "karigar" && <KarigarPanel biz={biz} contactId={panel.id} items={items} onClose={() => setPanel(null)} onChanged={reload}
        onIssue={(k) => setDialog({ kind: "issue", preset: { contactId: k.contact_id } })} onReceive={(k) => setDialog({ kind: "receive", preset: { contactId: k.contact_id } })}
        onOpenIssue={(id) => setPanel({ kind: "issue", id })} onOpenReceipt={(id) => setPanel({ kind: "receipt", id })} />}
      {panel?.kind === "issue" && <IssuePanel biz={biz} issueId={panel.id} onClose={() => setPanel(null)} onOpenReceipt={(id) => setPanel({ kind: "receipt", id })}
        onReceive={(i) => setDialog({ kind: "receive", preset: { contactId: i.contact_id, issueId: i.id } })} />}
      {panel?.kind === "receipt" && <ReceiptPanel biz={biz} receiptId={panel.id} onClose={() => setPanel(null)} />}
      {panel?.kind === "itc04" && <Itc04Panel biz={biz} onClose={() => setPanel(null)} />}
      <p className="muted small"><Badge tone="info" label="Not for sale" /> Pieces at a karigar stay the shop's stock and are not sold, sent elsewhere or counted off until they are back on a receipt.</p>
    </div>
  );
}
