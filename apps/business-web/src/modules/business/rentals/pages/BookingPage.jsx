import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { printTaxInvoice } from "../../core/pages/invoice";
import { CancelDialog, CheckoutDialog, ExtendDialog, ReceiptDialog, RefundDialog, ReturnDialog } from "./RentalDialogs";
import { printBookingSlip, printDepositReceipt, printMoneyBack } from "./rentalsPrint";
import { CHARGES, FUELS, STAGES, STATUS_WORDS, atWords, idWords, lateFor, lateWords, lineWords, messageLink, nowInput, wordOf } from "./rentals";
import "../../fashion/styles/business-fashion-electronics.css";
import "../styles/rentals.css";

// One booking: where it stands as the headline (worked out from its status,
// its times on the shop's clock and its money), the next steps as buttons
// (reserve a quote, hand over, take back, extend, take an advance or a
// deposit, cancel, hand money back), every line with its unit, period and
// price, what was noted at the handover and what came back; the money: the
// advances and deposits (collected, applied to the bill, handed back, held),
// the bill and what is due; the returns, the charges and the history; and the
// booking and handover slips.

export default function BookingPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { bookingId } = useParams();
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `rentals/bookings/${bookingId}`, undefined, controller.signal)
      .then((b) => { setBooking(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, bookingId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!booking) return <div className="stack"><BusinessHeader icon="calendar" title="Booking" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const money = booking.money !== false;
  const stage = booking.status === "out" && booking.overdue ? "overdue" : booking.status === "returned" || booking.status === "cancelled"
    ? (money && (Number(booking.bill?.due || 0) > 0 || Number(booking.deposit?.held || 0) + Number(booking.advance_summary?.left || 0) > 0) ? "to_settle" : booking.status === "returned" ? "closed" : "cancelled")
    : booking.status;
  const look = STAGES[stage] || { label: STATUS_WORDS[booking.status] || booking.status, tone: "neutral" };
  const held = money ? Number(booking.deposit?.held || 0) + Number(booking.advance_summary?.left || 0) : 0;
  const can = (p) => biz.can(p);
  const startsLater = booking.status === "reserved" && new Date(booking.out_at) > new Date();
  const startNow = () => businessWrite(biz.id, `rentals/bookings/${booking.id}`, { outAt: nowInput(biz) }, "patch")
    .then(() => refresh("Out time set to now.")).catch((err) => toast.error(getErrorMessage(err)));
  const reserve = () => businessWrite(biz.id, `rentals/bookings/${booking.id}/confirm`, {})
    .then(() => refresh(`${booking.booking_no} reserved.`)).catch((err) => toast.error(getErrorMessage(err)));
  const printBill = () => businessRead(biz.id, `documents/${booking.document_id}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)));
  const canPrint = can("rentals.print");
  const tell = (kind) => window.open(messageLink(biz, booking, kind), "_blank", "noopener");

  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title={`${booking.status === "quote" ? "Quote" : "Booking"} ${booking.booking_no}`}
        description={`${booking.customer_name}${booking.customer_phone ? ` · ${booking.customer_phone}` : ""} · ${booking.period}${booking.location_name ? ` · ${booking.location_name}` : ""}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("rental-bookings")}><Icon name="arrow-left" size={15} /> Bookings</Link>
            {canPrint && <button type="button" className="button button-secondary" onClick={() => printBookingSlip(biz, booking, booking.status === "quote" ? "quote" : "booking")}><Icon name="print" size={15} /> {booking.status === "quote" ? "Quote" : "Booking slip"}</button>}
            {canPrint && booking.checked_out_at && <button type="button" className="button button-secondary" onClick={() => printBookingSlip(biz, booking, "handover")}><Icon name="print" size={15} /> Handover slip</button>}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="calendar" tone={look.tone} label="Stage" value={look.label}
          note={booking.status === "out" ? (booking.overdue ? `${lateFor(booking.late_minutes)} late` : `due back ${atWords(booking.due_at, biz)}`)
            : booking.status === "reserved" ? `out ${atWords(booking.out_at, biz)}` : booking.returned_at ? `back ${atWords(booking.returned_at, biz)}` : undefined} />
        <StatTile icon="clock" tone={booking.overdue ? "danger" : "neutral"} label="Due back" value={atWords(booking.due_at, biz)} note={`out ${atWords(booking.out_at, biz)}`} />
        {money && <StatTile icon="money" tone="primary" label="Hire" money={Number(booking.total)} note={`GST ${biz.exact(booking.tax)}`} />}
        {money && <StatTile icon="wallet" tone={Number(booking.deposit.held) > 0 ? "warning" : "neutral"} label="Deposit held" money={Number(booking.deposit.held)}
          note={Number(booking.deposit_due) > 0 ? `asked ${biz.exact(booking.deposit_due)}` : "none asked"} />}
      </div>
      {(["quote", "reserved", "out"].includes(booking.status) || held > 0) && (
        <SectionCard icon="check" title="Next step">
          <div className="form-actions bz-start">
            {booking.status === "quote" && can("rentals.create") && <button type="button" className="button" onClick={reserve}>Reserve it</button>}
            {booking.status === "reserved" && can("rentals.edit") && (startsLater
              ? <button type="button" className="button" onClick={startNow}>Hand over now (start now)</button>
              : <button type="button" className="button" onClick={() => setDialog({ kind: "checkout" })}><Icon name="check" size={15} /> Hand over</button>)}
            {booking.status === "out" && can("rentals.edit") && <button type="button" className="button" onClick={() => setDialog({ kind: "return" })}><Icon name="check" size={15} /> Take back</button>}
            {booking.status === "out" && can("rentals.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "extend" })}><Icon name="clock" size={15} /> Extend</button>}
            {["quote", "reserved"].includes(booking.status) && can("rentals.edit") && <button type="button" className="button button-secondary" onClick={() => navigate(biz.path(`rental-bookings/new?edit=${booking.id}`))}><Icon name="edit" size={15} /> Change</button>}
            {["reserved", "out"].includes(booking.status) && money && can("rentals.edit") && can("sales.edit") && Number(booking.deposit_due) > Number(booking.deposit.held) && (
              <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "receipt", purpose: "deposit" })}><Icon name="wallet" size={15} /> Take the deposit</button>
            )}
            {["reserved", "out"].includes(booking.status) && money && can("rentals.edit") && can("sales.edit") && (
              <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "receipt", purpose: "advance" })}><Icon name="money" size={15} /> Take an advance</button>
            )}
            {["quote", "reserved"].includes(booking.status) && can("rentals.cancel") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "cancel" })}>Cancel</button>}
            {["returned", "cancelled"].includes(booking.status) && held > 0 && can("rentals.refund") && (
              <button type="button" className="button" onClick={() => setDialog({ kind: "refund" })}><Icon name="wallet" size={15} /> Hand back {biz.exact(held)}</button>
            )}
          </div>
          {booking.customer_phone && ["reserved", "out"].includes(booking.status) && (
            <div className="fe-tell rnt-tell">
              <button type="button" className="button button-secondary button-sm" onClick={() => tell(booking.status === "out" ? (booking.overdue ? "late" : "due") : "booked")}>
                <Icon name="message" size={14} /> WhatsApp {booking.status === "out" ? (booking.overdue ? "a late reminder" : "a due back reminder") : "the booking"}
              </button>
            </div>
          )}
          {money && booking.pending && (
            <p className="rnt-note">If all of it came back now: the bill {biz.exact(booking.pending.total)}{Number(booking.pending.late_fee) > 0 ? ` (late fee ${biz.exact(booking.pending.late_fee)} so far)` : ""}; {biz.exact(booking.pending.held)} held pays it first; {Number(booking.pending.to_pay) > 0 ? `${biz.exact(booking.pending.to_pay)} to pay` : `${biz.exact(booking.pending.back)} to hand back`}.</p>
          )}
        </SectionCard>
      )}
      <SectionCard flush icon="box" title="What is hired" description={booking.notes ? `Notes: ${booking.notes}` : undefined}>
        <DataGrid variant="compact" id="rental-booking-lines" caption="Lines of this booking" rows={booking.lines} rowKey={(l) => l.id} currency={biz.symbol} rowNoun={["line", "lines"]}
          rowClassName={(l) => (l.left === 0 && booking.checked_out_at ? "dg-tone-muted" : "")} columns={[
            { key: "item", header: "Item", value: (l) => lineWords(l), mobile: "title", pin: true,
              render: (l) => <span className="bz-two-line"><span>{l.item_name}</span><small className="muted">{l.unit_id ? `${l.unit_label}${l.serial_no ? ` · ${l.serial_no}` : ""}${l.unit_status !== "available" ? ` · ${l.unit_status}` : ""}` : `${l.quantity} from the pool`}</small></span> },
            { key: "period", header: "Charged for", value: (l) => l.period, render: (l) => <span className="bz-two-line"><span>{l.period}</span><small className="muted">{l.charged_hours} h</small></span> },
            money && { key: "amount", header: "Hire", type: "money", exact: true, value: (l) => (l.amount === null ? null : Number(l.amount)), total: "sum",
              render: (l) => <span className="bz-two-line"><span>{biz.exact(l.amount)}</span><small className="muted">{l.quantity > 1 ? `${biz.exact(l.price)} each · ` : ""}GST {Number(l.tax_rate)}%</small></span> },
            money && { key: "deposit", header: "Deposit", type: "money", exact: true, value: (l) => (l.deposit_each === null ? null : Number(l.deposit_each) * Number(l.quantity)) },
            { key: "out", header: "At the handover", value: (l) => l.out_note || "",
              render: (l) => (booking.checked_out_at ? <span className="bz-two-line"><span>{l.out_note || "Nothing noted"}</span>
                <small className="muted">{[l.meter_out ? `meter ${Number(l.meter_out)}` : null, l.fuel_out ? `fuel ${wordOf(FUELS, l.fuel_out).toLowerCase()}` : null].filter(Boolean).join(" · ")}</small></span> : <span className="muted">Not out yet</span>) },
            booking.checked_out_at && { key: "back", header: "Back", value: (l) => l.back, mobile: "show",
              render: (l) => <span className="bz-two-line"><span>{l.back} of {l.quantity}{l.missing ? ` · ${l.missing} missing` : ""}</span>
                <small className="muted">{l.left ? `${l.left} still out` : "all back"}{money && Number(l.late_fee_now) > 0 ? ` · late ${lateWords(l.late_units_now, l.late_per)} ${biz.exact(l.late_fee_now)}` : ""}</small></span> },
          ].filter(Boolean)} />
      </SectionCard>
      {booking.checked_out_at && (
        <SectionCard icon="user" title="The handover">
          <dl className="fe-facts">
            <div className="rnt-fact"><dt>Handed over</dt><dd>{atWords(booking.checked_out_at, biz)} by {booking.checked_out_by_name}</dd></div>
            {booking.id_kind && <div className="rnt-fact"><dt>Photo ID</dt><dd>{idWords(booking.id_kind, booking.id_ref)}</dd></div>}
            {booking.licence_no && <div className="rnt-fact"><dt>Driving licence</dt><dd>{booking.licence_no}, valid until {dateShort(booking.licence_valid_until, { year: true })}</dd></div>}
            {booking.deposit_waiver && <div className="rnt-fact"><dt>Less deposit</dt><dd>{booking.deposit_waived_by_name} agreed: {booking.deposit_waiver}</dd></div>}
          </dl>
        </SectionCard>
      )}
      {money && (booking.receipts.length > 0 || booking.bill) && (
        <SectionCard icon="receipt" title="Money" description="Advances are money on account for the hire. A deposit is held apart from sales: it pays the bill only when the booking comes back, and what is left goes back.">
          <dl className="fe-facts">
            {booking.bill && (
              <div className="rnt-fact"><dt><button type="button" className="link-button mono" title="Print the tax invoice" onClick={printBill}>{booking.bill.document_no}</button></dt>
                <dd>{biz.exact(booking.bill.total)}{Number(booking.bill.returned) > 0 ? ` · credited ${biz.exact(booking.bill.returned)}` : ""} · paid {biz.exact(Number(booking.bill.paid) - Number(booking.bill.refunded))} · <strong>due {biz.exact(Math.max(0, Number(booking.bill.due)))}</strong></dd></div>
            )}
            {booking.receipts.map((r) => (
              <div key={r.id} className="rnt-fact">
                <dt>{r.purpose === "deposit" ? "Deposit" : "Advance"} {r.collection_no}</dt>
                <dd>{biz.exact(r.amount)} · {r.purpose === "deposit" ? "applied" : "used"} {biz.exact(r.used)} · handed back {biz.exact(r.refunded)} · <strong>held {biz.exact(r.free)}</strong>
                  {canPrint && r.purpose === "deposit" && <button type="button" className="chip-button rnt-inline" onClick={() => printDepositReceipt(biz, booking, r)}><Icon name="print" size={13} /> Receipt</button>}</dd>
              </div>
            ))}
          </dl>
          {booking.receipts.some((r) => r.refunds.length > 0) && (
            <ul className="rnt-refunds">
              {booking.receipts.flatMap((r) => r.refunds.map((f) => ({ ...f, collection_no: r.collection_no, purpose: r.purpose }))).map((f) => (
                <li key={f.id}>
                  <span>{f.refund_no} · {f.purpose === "deposit" ? "deposit" : "advance"} {biz.exact(f.amount)} handed back · {atWords(f.created_at, biz)} · approved by {f.approved_by_name} — {f.reason}</span>
                  <button type="button" className="chip-button" onClick={() => printMoneyBack(biz, booking, f)}><Icon name="print" size={13} /> Receipt</button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      {booking.returns.length > 0 && (
        <SectionCard flush icon="check" title="Returns">
          <DataGrid variant="compact" id="rental-booking-returns" caption="Returns of this booking" rows={booking.returns.flatMap((r) => r.lines.map((x) => ({ ...x, at: r.created_at, by: r.by_name, final: r.final, key: `${r.id}:${x.line_id}` })))}
            rowKey={(x) => x.key} currency={biz.symbol} rowNoun={["return", "returns"]} columns={[
              { key: "at", header: "When", type: "datetime", value: (x) => x.at, mobile: "subtitle", render: (x) => atWords(x.at, biz) },
              { key: "item", header: "Item", value: (x) => x.unit_label || x.item_name, mobile: "title" },
              { key: "back", header: "Back", value: (x) => x.quantity, render: (x) => `${x.quantity}${x.missing ? ` · ${x.missing} missing` : ""}${x.maintenance ? " · for maintenance" : ""}` },
              { key: "late", header: "Late", value: (x) => x.late_minutes, render: (x) => (x.late_units ? `${lateFor(x.late_minutes)}${money ? ` · ${biz.exact(x.late_fee)}` : ""}` : <span className="muted">On time</span>) },
              { key: "note", header: "Noted", value: (x) => x.note || "", render: (x) => [x.note, x.meter_in ? `meter ${Number(x.meter_in)}` : null, x.fuel_in ? `fuel ${wordOf(FUELS, x.fuel_in).toLowerCase()}` : null].filter(Boolean).join(" · ") || <span className="muted">—</span> },
              { key: "by", header: "By", value: (x) => x.by },
            ]} />
        </SectionCard>
      )}
      {money && booking.charges.length > 0 && (
        <SectionCard flush icon="alert" title="Charges">
          <DataGrid variant="compact" id="rental-booking-charges" caption="Charges on this booking" rows={booking.charges} rowKey={(x) => x.id} currency={biz.symbol} rowNoun={["charge", "charges"]} columns={[
            { key: "kind", header: "Charge", value: (x) => wordOf(CHARGES, x.kind) || "Cancellation charge", mobile: "title", render: (x) => (x.kind === "cancellation" ? "Cancellation charge" : wordOf(CHARGES, x.kind)) },
            { key: "item", header: "For", value: (x) => x.unit_label || x.item_name },
            { key: "note", header: "Note", value: (x) => x.note || "" },
            { key: "amount", header: "Amount", type: "money", exact: true, value: (x) => Number(x.amount), total: "sum" },
            { key: "billed", header: "Billed", value: (x) => (x.line_id ? "Billed" : "With the bill"), render: (x) => (x.line_id ? <Badge tone="success" label="Billed" /> : <Badge tone="warning" label="With the bill" />) },
          ]} />
        </SectionCard>
      )}
      <SectionCard flush icon="history" title="History">
        <DataGrid variant="compact" id="rental-booking-history" caption="History of this booking" rows={booking.events} rowKey={(e) => e.id} rowNoun={["change", "changes"]} columns={[
          { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle", render: (e) => atWords(e.created_at, biz) },
          { key: "to_status", header: "Status", value: (e) => STATUS_WORDS[e.to_status] || "", mobile: "title",
            render: (e) => (e.to_status ? <Badge tone={STAGES[e.to_status]?.tone || "neutral"} label={STATUS_WORDS[e.to_status] || e.to_status} /> : <span className="muted small">Note</span>) },
          { key: "note", header: "Note", value: (e) => e.note || "", mobile: "show" },
          { key: "by", header: "By", value: (e) => e.by_name },
        ]} />
      </SectionCard>
      {dialog?.kind === "checkout" && <CheckoutDialog booking={booking} onClose={() => setDialog(null)} onSaved={(b) => refresh(`${b.booking_no} handed over.`)} />}
      {dialog?.kind === "return" && <ReturnDialog booking={booking} onClose={() => setDialog(null)}
        onSaved={(b) => refresh(b.status === "returned" ? `${b.booking_no} back and billed (${b.document_no}).` : `${b.booking_no}: part of it back.`)} />}
      {dialog?.kind === "extend" && <ExtendDialog booking={booking} onClose={() => setDialog(null)} onSaved={(b) => refresh(`${b.booking_no}: due back ${atWords(b.due_at, biz)}.`)} />}
      {dialog?.kind === "receipt" && <ReceiptDialog booking={booking} purpose={dialog.purpose} onClose={() => setDialog(null)}
        onSaved={() => refresh(dialog.purpose === "deposit" ? "Deposit taken." : "Advance taken.")} />}
      {dialog?.kind === "cancel" && <CancelDialog booking={booking} onClose={() => setDialog(null)} onSaved={(b) => refresh(`${b.booking_no} cancelled.`)} />}
      {dialog?.kind === "refund" && <RefundDialog booking={booking} held={held} onClose={() => setDialog(null)} onSaved={(r) => {
        for (const f of r.refunds.filter((x) => !x.repeated)) printMoneyBack(biz, r.booking, f);
        refresh(`${biz.exact(r.refunds.reduce((s, f) => s + Number(f.amount), 0))} handed back.`);
      }} />}
    </div>
  );
}
