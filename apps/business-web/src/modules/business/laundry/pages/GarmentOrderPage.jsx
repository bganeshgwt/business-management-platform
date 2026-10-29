import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { printRefundReceipt } from "../../salon/pages/salonBackOffice";
import { printTaxInvoice } from "../../core/pages/invoice";
import { Segmented } from "../../fashion/pages/shared";
import { AddGarmentsDialog, AdvanceRefundDialog, CancelDialog, ChangeDialog, ClaimDialog, DecideDialog, DeliverDialog, DetailsDialog, ItemDialog, QcDialog, StatusDialog } from "./LaundryDialogs";
import { LaundryPicture, PhotoButton } from "./LaundryFiles";
import { uploadLaundryFile } from "./laundryUploads";
import { printOrderReceipt, printTags, TAG_LAYOUTS } from "./laundryPrint";
import { DECISIONS, ISSUES, ITEM_STATUSES, LIEN_NOTE, NOTICES, OPEN, ORDER_STATUSES, PRICE_SOURCES, defectWords, messageLink, noticeFor, offWords, quantityWords, wordOf } from "./laundry";
import "../styles/laundry.css";

// One garment order: its status as the headline (worked out from its
// garments), the next steps as buttons (into the work, the quality check,
// packed, ready on a rack, the handover piece by piece, garments added or
// changed, cancelling garments, a damage claim), photos of the garments and
// the customer's signature, WhatsApp or a call with a
// message for the stage, every garment with its tag, what was noted about it
// at intake and what the customer acknowledged, its status and rack and its
// charge; the bills, the advance and what is still to pay; the handovers; the
// damage claims with a manager's decision; the history; the receipt and the
// tag labels.

export default function GarmentOrderPage() {
  const biz = useOpenBusiness();
  const { orderId } = useParams();
  const [params, setParams] = useSearchParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const [layout, setLayout] = useState("roll");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `laundry/orders/${orderId}`, undefined, controller.signal)
      .then((o) => { setOrder(o); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, orderId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!order) return <div className="stack"><BusinessHeader icon="clipboard" title="Garment order" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const money = order.money !== false;
  const status = ORDER_STATUSES[order.status] || { label: order.status, tone: "neutral" };
  const today = businessToday(biz.business.timezone);
  const inShop = order.items.filter((i) => OPEN.includes(i.status));
  const has = (s) => order.items.some((i) => i.status === s);
  const edit = biz.can("laundry.edit");
  const late = inShop.some((i) => i.status !== "ready") && order.promised_on < today;
  const toPay = money ? Math.max(0, Number(order.due) + Number(order.bill?.due || 0)) : 0;
  const advanceFree = order.advance ? Number(order.advance.free) : 0;
  const unbilledInShop = inShop.some((i) => !i.line_id);
  const taken = params.get("taken") === "1";
  const dismissTaken = () => setParams((p) => { const next = new URLSearchParams(p); next.delete("taken"); return next; }, { replace: true });
  const tell = (kind) => {
    if (order.customer_phone) window.open(messageLink(biz, order, kind), "_blank", "noopener");
    businessWrite(biz.id, `laundry/orders/${order.id}/notices`, { kind, channel: "whatsapp" }).then(() => refresh()).catch((err) => toast.error(getErrorMessage(err)));
  };
  const call = () => businessWrite(biz.id, `laundry/orders/${order.id}/notices`, { kind: noticeFor(order.status), channel: "call" }).then(() => refresh()).catch(() => {});
  const canPrint = biz.can("laundry.print");
  const printAllTags = () => printTags(biz, order, order.items.filter((i) => OPEN.includes(i.status)), layout);
  const { open, ready, delivered, cancelled } = order.counts;
  const checks = order.checks || {};
  const photo = (item) => async (file) => {
    await uploadLaundryFile(biz, { orderId: order.id, kind: "photo", itemId: item.id, stage: item.status === "received" ? "intake" : "qc" }, file);
    refresh("Photo kept.");
  };
  const canPhoto = (item) => (item.status === "received" ? biz.can("laundry.create") : ["in_process", "qc", "packed", "ready"].includes(item.status) && edit);
  const photoOf = (fileId) => order.items.find((i) => i.id === order.files.find((f) => f.id === fileId)?.item_id);
  const handed = `${delivered} ${delivered === 1 ? "garment" : "garments"} handed over`;
  const progress = open > 0 ? (delivered ? `${delivered} handed over · ${ready} of the other ${open} ready` : `${ready} of ${open} ready`)
    : delivered > 0 ? handed : `${cancelled} cancelled`;

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={`Order ${order.order_no}`}
        description={`${order.customer_name}${order.customer_phone ? ` · ${order.customer_phone}` : ""} · taken in on ${dateTime(order.created_at)} at ${order.location_name} by ${order.created_by_name}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("garment-orders")}><Icon name="arrow-left" size={15} /> All orders</Link>
            {canPrint && (
              <>
                <button type="button" className="button button-secondary" onClick={() => printOrderReceipt(biz, order)}><Icon name="print" size={15} /> Receipt</button>
                <Segmented label="Tag labels on" options={Object.keys(TAG_LAYOUTS).map((value) => ({ value, label: value === "roll" ? "Roll" : "A4" }))} value={layout} onChange={setLayout} />
                <button type="button" className="button button-secondary" onClick={printAllTags} disabled={!inShop.length}><Icon name="tag" size={15} /> Tags</button>
              </>
            )}
          </>
        )} />
      <ErrorMessage message={error} />
      {taken && (
        <SectionCard icon="check" title="Taken in" description="Print the receipt for the customer and a tag for every piece; the tags go on the garments now."
          actions={<button type="button" className="link-button" onClick={dismissTaken}>Done</button>}>
          {canPrint && (
            <div className="form-actions bz-start">
              <button type="button" className="button" onClick={() => printOrderReceipt(biz, order)}><Icon name="print" size={15} /> Print the receipt</button>
              <button type="button" className="button button-secondary" onClick={printAllTags}><Icon name="tag" size={15} /> Print the tags ({TAG_LAYOUTS[layout].label})</button>
              {order.signed && <span className="ldy-signed"><Icon name="check" size={15} /> Signed by the customer on the screen</span>}
              {order.customer_phone && <button type="button" className="button button-secondary" onClick={() => tell("received")}><Icon name="message" size={15} /> WhatsApp the order</button>}
              <Link className="button button-secondary" to={biz.path("laundry-new")}><Icon name="plus" size={15} /> Next order</Link>
            </div>
          )}
        </SectionCard>
      )}
      <div className="stat-grid">
        <StatTile icon="clipboard" tone={status.tone} label="Status" value={status.label}
          note={`${progress} · ${order.counts.pieces} ${order.counts.pieces === 1 ? "piece" : "pieces"}${order.express ? " · express" : ""}`} />
        <StatTile icon="calendar" tone={late ? "danger" : "neutral"} label="Promised for" value={order.promised_on === today ? "Today" : dateShort(order.promised_on, { year: true })}
          note={late ? "late" : order.bill_at === "intake" ? "billed at intake" : "billed when handed over"} />
        {money && <StatTile icon="money" tone="primary" label="Total" money={Number(order.total)} note={order.express ? `express +${Number(order.express_percent)}%` : undefined} />}
        {money && <StatTile icon="wallet" tone={toPay > 0 ? "warning" : "success"} label="To pay" money={toPay}
          note={order.bills.length ? `${order.bills.map((b) => b.document_no).join(", ")} · paid ${biz.exact(order.paid)}` : order.advance ? `advance ${biz.exact(order.advance.amount)}` : "nothing billed yet"} />}
      </div>
      {inShop.length > 0 && (
        <SectionCard icon="check" title="Next step">
          <div className="form-actions bz-start">
            {edit && has("ready") && <button type="button" className="button" onClick={() => setDialog({ kind: "deliver" })}><Icon name="check" size={15} /> Hand over</button>}
            {edit && has("received") && <button type="button" className={`button ${has("ready") ? "button-secondary" : ""}`} onClick={() => setDialog({ kind: "status", to: "in_process" })}>Into the work</button>}
            {edit && (has("received") || has("in_process")) && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "status", to: "qc" })}>To the quality check</button>}
            {edit && has("qc") && <button type="button" className="button" onClick={() => setDialog({ kind: "qc" })}>Quality check</button>}
            {edit && !checks.qc && (has("received") || has("in_process")) && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "status", to: "packed" })}>Packed</button>}
            {edit && (has("packed") || (!checks.qc && !checks.packing && (has("received") || has("in_process")))) && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "status", to: "ready" })}>Ready on a rack</button>}
            {edit && (has("ready") || has("packed")) && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "status", to: "in_process", back: true })}>Back into the work</button>}
            {biz.can("laundry.create") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "add" })}><Icon name="plus" size={15} /> Add garments</button>}
            {edit && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "details" })}><Icon name="edit" size={15} /> Promised day</button>}
            {biz.can("laundry.cancel") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "cancel" })}>Cancel garments</button>}
          </div>
          {money && has("ready") && toPay > 0 && <p className="ldy-note">{LIEN_NOTE}</p>}
        </SectionCard>
      )}
      {inShop.length > 0 && (
        <SectionCard icon="message" title="Tell the customer" description="Opens WhatsApp with the message ready; it is noted in the history below.">
          <div className="fe-tell">
            {NOTICES.map((n) => (
              <button key={n.value} type="button" className={`button ${n.value === noticeFor(order.status) ? "" : "button-secondary"} button-sm`} onClick={() => tell(n.value)}><Icon name="message" size={14} /> {n.label}</button>
            ))}
            {order.customer_phone && <a className="button button-secondary button-sm" href={`tel:${order.customer_phone.replace(/[^\d+]/g, "")}`} onClick={call}><Icon name="phone" size={14} /> Call {order.customer_phone}</a>}
          </div>
        </SectionCard>
      )}
      <SectionCard flush icon="tag" title="Garments" description={order.notes ? `Notes: ${order.notes}` : undefined}
        actions={edit && order.items.some((i) => i.status !== "cancelled" && !i.claim_open) && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "claim" })}><Icon name="alert" size={14} /> Damage claim</button>}>
        <DataGrid variant="compact" id="laundry-order-garments" caption="Garments on this order" rows={order.items} rowKey={(i) => i.id} currency={biz.symbol} rowNoun={["garment", "garments"]}
          rowClassName={(i) => (i.status === "cancelled" ? "dg-tone-muted" : i.claim_open ? "dg-tone-warning" : i.status === "ready" ? "dg-tone-success" : "")} columns={[
            { key: "tag", header: "Tag", value: (i) => i.tag_no, className: "mono", mobile: "title", pin: true },
            { key: "garment", header: "Garment", value: (i) => `${i.garment_name} ${i.colour || ""} ${i.brand || ""}`,
              render: (i) => <span className="bz-two-line"><span>{i.garment_name} · {i.service_name}</span><small className="muted">{[quantityWords(i), i.colour, i.brand,
                i.intake_photos + i.qc_photos ? `${i.intake_photos + i.qc_photos} ${i.intake_photos + i.qc_photos === 1 ? "photo" : "photos"}` : null,
                i.added_at ? `added by ${i.added_by_name}` : null, i.changes ? "changed after intake" : null].filter(Boolean).join(" · ")}</small></span> },
            { key: "noted", header: "Noted at intake", value: (i) => defectWords(i),
              render: (i) => (defectWords(i) || i.risk_note || i.instructions ? (
                <span className="bz-two-line"><span>{defectWords(i) || (i.risk_note ? "Risk explained" : "Instructions")}</span>
                  <small className="muted">{[i.risk_note, i.instructions, i.acknowledged ? "acknowledged by the customer" : null, i.declared_value ? `value declared ${biz.exact(i.declared_value)}` : null].filter(Boolean).join(" · ")}</small></span>
              ) : <span className="muted">Nothing</span>) },
            { key: "status", header: "Status", value: (i) => ITEM_STATUSES[i.status]?.label, mobile: "show",
              render: (i) => <span className="bz-two-line"><Badge tone={ITEM_STATUSES[i.status]?.tone} label={ITEM_STATUSES[i.status]?.label || i.status} />
                <small className="muted">{[i.rack ? `rack ${i.rack}` : null, Number(i.pieces_delivered) > 0 && i.status !== "delivered" ? `${i.pieces_delivered} of ${i.pieces} handed over` : null,
                  i.rewashes ? `washed again ${i.rewashes === 1 ? "once" : `${i.rewashes} times`}` : null, i.qc_by_name ? `checked by ${i.qc_by_name}` : null,
                  i.claim_open ? "claim waiting" : null, i.cancel_reason].filter(Boolean).join(" · ")}</small></span> },
            money && { key: "amount", header: "Charge", type: "money", exact: true, value: (i) => (i.net === null ? null : Number(i.net) + Number(i.tax)), total: "sum",
              render: (i) => <span className="bz-two-line"><span>{biz.exact(Number(i.net) + Number(i.tax))}</span><small className="muted">{[i.document_no, Number(i.credited || 0) > 0 ? `${biz.exact(i.credited)} credited` : null,
                i.price_source && i.price_source !== "list" ? PRICE_SOURCES[i.price_source] : null, offWords(biz.exact, i)].filter(Boolean).join(" · ")}</small></span> },
            (edit || biz.can("laundry.create")) && { key: "actions", header: "", label: "Actions", type: "actions", render: (i) => (OPEN.includes(i.status) ? (
              <span className="bz-row-actions">
                {edit && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "item", item: i })}>{i.status === "ready" ? "Tag or rack" : "Re-tag"}</button>}
                {canPrint && <button type="button" className="chip-button" onClick={() => printTags(biz, order, [i], layout)}><Icon name="tag" size={13} /> Tag</button>}
                {i.status === "received" && biz.can("laundry.cancel") && !i.claim_open && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "change", item: i })}>Change</button>}
                {canPhoto(i) && <PhotoButton className="chip-button" label="Photo" onUpload={photo(i)} />}
              </span>
            ) : null) },
          ].filter(Boolean)} />
      </SectionCard>
      {order.files.length > 0 && (
        <SectionCard icon="eye" title="Photos and signature" description="Kept with the order as they were taken; never changed.">
          <ul className="ldy-pictures">
            {order.files.map((f) => (
              <li key={f.id}>
                <LaundryPicture biz={biz} fileId={f.id} alt={f.kind === "signature" ? "The customer's signature" : `Photo of garment ${photoOf(f.id)?.tag_no || ""}`} />
                <span>{f.kind === "signature" ? "Customer's signature" : `${photoOf(f.id)?.tag_no || ""} · ${f.stage === "intake" ? "at intake" : "at QC"}`} · {dateTime(f.created_at)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      {money && (order.bills.length > 0 || order.bill || order.advance) && (
        <SectionCard icon="receipt" title="Bills and money"
          description={order.bill ? (order.bill.rate_changed ? "A service's GST rate changed after intake: a bill keeps the price taken in and works out GST at the rate of the day." : "The garments not billed yet are billed when handed over, as below today.") : undefined}
          actions={!unbilledInShop && advanceFree > 0 && biz.can("sales.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "advance" })}><Icon name="wallet" size={14} /> Hand back the advance</button>}>
          <dl className="fe-facts">
            {order.bills.map((b) => (
              <div key={b.id} className="ldy-fact-row"><dt><button type="button" className="link-button mono" title="Print the tax invoice"
                onClick={() => businessRead(biz.id, `documents/${b.id}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)))}>{b.document_no}</button></dt>
                <dd>{biz.exact(b.total)}{Number(b.returned) > 0 ? ` · credited ${biz.exact(b.returned)}` : ""} · paid {biz.exact(Number(b.paid) - Number(b.refunded))} · <strong>due {biz.exact(Math.max(0, Number(b.due)))}</strong></dd></div>
            ))}
            {order.bill && <div className="ldy-fact-row"><dt>Not billed yet</dt><dd>{biz.exact(order.bill.total)} (GST {biz.exact(order.bill.tax)}){Number(order.bill.advance) > 0 ? ` · the advance pays ${biz.exact(order.bill.advance)}` : ""} · <strong>{biz.exact(order.bill.due)} to pay</strong></dd></div>}
            {order.advance && <div className="ldy-fact-row"><dt>Advance {order.advance.collection_no}</dt><dd>{biz.exact(order.advance.amount)} · used {biz.exact(order.advance.used)} · handed back {biz.exact(order.advance.refunded)} · <strong>left {biz.exact(order.advance.free)}</strong></dd></div>}
          </dl>
          {(order.advance?.refunds || []).length > 0 && (
            <ul className="ldy-refunds">
              {order.advance.refunds.map((r) => (
                <li key={r.id}>
                  <span>{r.refund_no} · {biz.exact(r.amount)} · {dateTime(r.created_at)} · approved by {r.approved_by_name} — {r.reason}</span>
                  <button type="button" className="chip-button" onClick={() => printRefundReceipt(biz, { ...r, collection_no: order.advance.collection_no }, order.customer_name)}><Icon name="print" size={13} /> Receipt</button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      {order.deliveries.length > 0 && (
        <SectionCard flush icon="check" title="Handovers">
          <DataGrid variant="compact" id="laundry-order-handovers" caption="Handovers of this order" rows={order.deliveries} rowKey={(d) => d.id} rowNoun={["handover", "handovers"]} columns={[
            { key: "created_at", header: "When", type: "datetime", value: (d) => d.created_at, mobile: "subtitle" },
            { key: "tags", header: "Tags", value: (d) => (d.tags || []).join(", "), className: "mono", mobile: "title" },
            { key: "bill", header: "Bill", value: (d) => d.document_no || "", render: (d) => d.document_no || <span className="muted">None (billed already)</span> },
            { key: "account", header: "Money still owed", value: (d) => (d.on_account ? "On the account" : ""), render: (d) => (d.on_account ? <Badge tone="warning" label="On the account" /> : <span className="muted">—</span>) },
            { key: "collected_by", header: "Collected by", value: (d) => d.collected_by || "", render: (d) => d.collected_by || <span className="muted">The customer</span> },
            { key: "by", header: "By", value: (d) => d.by_name },
          ]} />
        </SectionCard>
      )}
      {order.claims.length > 0 && (
        <SectionCard flush icon="alert" title="Damage claims" description="A printed disclaimer does not decide a claim: what was noted and acknowledged at intake is on the garment.">
          <DataGrid variant="compact" id="laundry-order-claims" caption="Damage claims on this order" rows={order.claims} rowKey={(x) => x.id} currency={biz.symbol} rowNoun={["claim", "claims"]}
            rowClassName={(x) => (x.decision ? "" : "dg-tone-warning")} columns={[
              { key: "tag", header: "Garment", value: (x) => `${x.tag_no} ${x.garment_name}`, mobile: "title", render: (x) => <span className="bz-two-line"><span className="mono">{x.tag_no}</span><small className="muted">{x.garment_name}</small></span> },
              { key: "issue", header: "Claim", value: (x) => x.description, render: (x) => <span className="bz-two-line"><span>{wordOf(ISSUES, x.issue)}</span><small className="muted">{x.description}</small></span> },
              { key: "reported", header: "Reported", type: "datetime", value: (x) => x.reported_at, render: (x) => <span className="bz-two-line"><span>{dateTime(x.reported_at)}</span><small className="muted">by {x.reported_by_name}</small></span> },
              money && { key: "asked", header: "Asked", type: "money", exact: true, value: (x) => (x.asked_amount === null ? null : Number(x.asked_amount)) },
              { key: "decision", header: "Decision", value: (x) => (x.decision ? wordOf(DECISIONS, x.decision) : "Waiting"), mobile: "show",
                render: (x) => (x.decision ? <span className="bz-two-line"><Badge tone={x.decision === "rejected" ? "neutral" : "success"} label={wordOf(DECISIONS, x.decision)} />
                  <small className="muted">{[money && x.amount ? biz.exact(x.amount) : null, x.return_no, money && x.refunded ? `${biz.exact(x.refunded)} refunded` : null, x.decision_note, x.decided_by_name].filter(Boolean).join(" · ")}</small></span>
                  : <Badge tone="warning" label="Waiting for a manager" />) },
              biz.can("laundry.refund") && { key: "actions", header: "", label: "Actions", type: "actions",
                render: (x) => (!x.decision ? <button type="button" className="chip-button" onClick={() => setDialog({ kind: "decide", claim: x })}>Decide</button> : null) },
            ].filter(Boolean)} />
        </SectionCard>
      )}
      <SectionCard flush icon="history" title="History">
        <DataGrid variant="compact" id="laundry-order-history" caption="History of this order" rows={order.events} rowKey={(e) => e.id} rowNoun={["change", "changes"]} columns={[
          { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
          { key: "tag", header: "Tag", value: (e) => e.tag_no || "", className: "mono", render: (e) => e.tag_no || <span className="muted">Order</span> },
          { key: "to_status", header: "Status", value: (e) => ITEM_STATUSES[e.to_status]?.label || "", mobile: "title",
            render: (e) => (e.to_status ? <Badge tone={ITEM_STATUSES[e.to_status]?.tone} label={ITEM_STATUSES[e.to_status]?.label || e.to_status} /> : <span className="muted small">Note</span>) },
          { key: "note", header: "Note", value: (e) => e.note || "", mobile: "show" },
          { key: "by", header: "By", value: (e) => e.by_name },
        ]} />
      </SectionCard>
      {dialog?.kind === "status" && <StatusDialog order={order} to={dialog.to} back={dialog.back} onClose={() => setDialog(null)}
        onSaved={(o) => refresh(dialog.to === "ready" ? `${o.order_no}: ${ORDER_STATUSES[o.status].label.toLowerCase()}.` : dialog.to === "qc" ? `${o.order_no}: garments at the quality check.`
          : dialog.to === "packed" ? `${o.order_no}: garments packed.` : `${o.order_no}: garments in the work.`)} />}
      {dialog?.kind === "qc" && <QcDialog order={order} onClose={() => setDialog(null)} onSaved={(o) => refresh(`${o.order_no}: quality check saved.`)} />}
      {dialog?.kind === "change" && <ChangeDialog order={order} item={dialog.item} onClose={() => setDialog(null)} onSaved={() => refresh(`Garment ${dialog.item.tag_no} changed.`)} />}
      {dialog?.kind === "add" && <AddGarmentsDialog order={order} onClose={() => setDialog(null)} onSaved={(o) => refresh(`${o.order_no}: garments added.`)} />}
      {dialog?.kind === "item" && <ItemDialog order={order} item={dialog.item} onClose={() => setDialog(null)} onSaved={() => refresh("Garment saved.")} />}
      {dialog?.kind === "deliver" && <DeliverDialog order={order} onClose={() => setDialog(null)}
        onSaved={(o) => { const last = o.deliveries.at(-1); refresh(last?.document_no ? `Handed over and billed (${last.document_no}).` : "Handed over."); }} />}
      {dialog?.kind === "cancel" && <CancelDialog order={order} onClose={() => setDialog(null)} onSaved={(o) => refresh(`${o.order_no}: garments cancelled.`)} />}
      {dialog?.kind === "claim" && <ClaimDialog order={order} onClose={() => setDialog(null)} onSaved={() => refresh("Claim recorded: a manager decides it.")} />}
      {dialog?.kind === "decide" && <DecideDialog order={order} claim={dialog.claim} onClose={() => setDialog(null)} onSaved={() => refresh(`Claim ${dialog.claim.id} decided.`)} />}
      {dialog?.kind === "details" && <DetailsDialog order={order} onClose={() => setDialog(null)} onSaved={() => refresh("Order saved.")} />}
      {dialog?.kind === "advance" && <AdvanceRefundDialog order={order} free={advanceFree} onClose={() => setDialog(null)} onSaved={(r) => {
        printRefundReceipt(biz, { ...r, collection_no: order.advance.collection_no }, order.customer_name);
        refresh(`${r.refund_no}: ${biz.exact(r.amount)} handed back.`);
      }} />}
    </div>
  );
}
