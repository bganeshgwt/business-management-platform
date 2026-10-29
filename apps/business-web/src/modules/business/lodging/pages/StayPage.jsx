import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { printTaxInvoice } from "../../core/pages/invoice";
import { CancelDialog, ChangeStayDialog, ChargeDialog, CheckInDialog, CheckOutDialog, ReceiptDialog, RefundDialog, VoidDialog } from "./LodgingDialogs";
import { printMoneyBack, printRegistrationCard } from "./lodgingPrint";
import { MovePropertyDialog } from "./HouseDialogs";
import { AddOccupantDialog, FoliosSection, LeaveDialog, MoveChargeDialog, OpenFolioDialog, PolicySection, ProfileDialog, ProfileSection, RoutingDialog } from "./StayParts";
import { CHARGE_KINDS, MEAL_PLANS, RATE_KINDS, SOURCES, STAGES, STATUS_WORDS, atWords, dateWords, folioName, idWords, partyWords, stayWords, wordOf } from "./lodging";
import "../styles/lodging.css";

// One stay: where it stands as the headline (its status, its dates on the
// business's clock and its money), the next steps as buttons (check in, take an
// advance, add a charge, change or move, check out, cancel or mark a no-show,
// hand money back), the occupants with their IDs and Form-III reports, the
// folio (every night at its own rate and slab, posted or still to post, and the
// extras), the money held and the bill, and the history; the registration card.
// Its rate plan, discount, day use and group; the policy it was booked under
// with what it charges now; its folios with the routing of its charges and a
// charge moved; an occupant joining or leaving partway; the guest's profile
// (StayParts.jsx). A guest in the house moved to another property: checked
// out and billed here, checked in there, the two stays linked (HouseDialogs.jsx).
// ?do=check-in or ?do=check-out opens that step (from the front desk).

export default function StayPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { stayId } = useParams();
  const [params, setParams] = useSearchParams();
  const [stay, setStay] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  // A step asked for from the front desk (?do=…) opens once, when the stay is here.
  const [asked, setAsked] = useState(() => params.get("do"));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `lodging/stays/${stayId}`, undefined, controller.signal)
      .then((s) => {
        setStay(s);
        setError("");
        if (!asked) return;
        if (asked === "check-in" && s.status === "reserved" && biz.can("lodging.create")) setDialog({ kind: "checkin" });
        if (asked === "check-out" && s.status === "in_house" && biz.can("lodging.create")) setDialog({ kind: "checkout" });
        setAsked(null);
        setParams((p) => { p.delete("do"); return p; }, { replace: true });
      })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, stayId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!stay) return <div className="stack"><BusinessHeader icon="home" title="Stay" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const money = stay.money !== false;
  const held = money ? Number(stay.folio?.held || 0) : 0;
  const ended = ["checked_out", "cancelled", "no_show"].includes(stay.status);
  const stage = ended ? (money && (Number(stay.bill?.due || 0) > 0 || held > 0) ? "to_settle" : stay.status)
    : stay.status === "reserved" ? (stay.arrival < stay.today ? "late_arrival" : stay.arrival === stay.today ? "arriving" : "reserved")
      : stay.departure < stay.today ? "overstay" : stay.departure === stay.today ? "due_out" : "in_house";
  const look = STAGES[stage] || { label: STATUS_WORDS[stay.status], tone: "neutral" };
  const can = (p) => biz.can(p);
  const printBill = () => businessRead(biz.id, `documents/${stay.document_id}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)));
  const foreigners = stay.guests.filter((g) => g.foreigner);
  const toPost = (stay.nights || []).filter((n) => !n.posted);
  const split = (stay.folios || []).length > 0;
  const canMove = stay.status === "in_house" && can("lodging.create") && split;
  const folioRows = [
    ...stay.charges.map((x) => ({ ...x, key: `c${x.id}`, state: x.voided_at ? "voided" : x.line_id ? "billed" : "posted" })),
    ...toPost.map((n) => ({ key: `n${n.night}`, kind: "room_night", night: n.night, label: `${stay.room_type}${stay.room_no ? ` · room ${stay.room_no}` : ""} · night of ${dateWords(n.night)}`,
      rate_kind: n.rate_kind, amount: n.amount, tax_rate: n.tax_rate, tax: n.tax, net: n.amount, state: "to_post", folio_id: stay.routes?.room || null })),
  ].sort((a, b) => (a.kind === "room_night") === (b.kind === "room_night") ? String(a.night).localeCompare(String(b.night)) : a.kind === "room_night" ? -1 : 1);
  const STATE_WORDS = { posted: ["Posted", "info"], billed: ["Billed", "success"], voided: ["Voided", "neutral"], to_post: ["To post", "warning"] };

  return (
    <div className="stack">
      <BusinessHeader icon="home" title={`Stay ${stay.stay_no}`}
        description={`${stay.guest_name}${stay.guest_phone ? ` · ${stay.guest_phone}` : ""} · ${stay.day_use ? `day use on ${dateWords(stay.arrival)}` : stayWords(stay.arrival, stay.departure)} · ${stay.room_type}${stay.room_no ? ` · room ${stay.room_no}` : ""}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path(can("lodging.create") ? "lodging-desk" : "lodging-stays")}><Icon name="arrow-left" size={15} /> {can("lodging.create") ? "Front desk" : "Stays"}</Link>
            {can("lodging.print") && stay.checked_in_at && <button type="button" className="button button-secondary" onClick={() => printRegistrationCard(biz, stay)}><Icon name="print" size={15} /> Registration card</button>}
            {money && stay.document_id && <button type="button" className="button button-secondary" onClick={printBill}><Icon name="print" size={15} /> Bill</button>}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="home" tone={look.tone} label="Stage" value={look.label} note={stay.room_no ? `room ${stay.room_no}` : "no room yet"} />
        <StatTile icon="calendar" label="Nights" value={String(stay.nights_count)} note={`${dateWords(stay.arrival)} to ${dateWords(stay.departure)}`} />
        {money && <StatTile icon="money" tone="primary" label={ended ? "Billed" : "Folio"} money={Number(ended ? stay.bill?.total || 0 : Number(stay.folio.posted) + Number(stay.folio.to_post))}
          note={ended ? (stay.bill ? `due ${biz.exact(Math.max(0, Number(stay.bill.due)))}` : "nothing billed") : `${biz.exact(stay.folio.posted)} posted · ${biz.exact(stay.folio.to_post)} to post`} />}
        {money && <StatTile icon="wallet" tone={held > 0 ? "warning" : "neutral"} label="Held" money={held} note={`advance ${biz.exact(stay.advance_summary.taken)} · deposit ${biz.exact(stay.deposit.collected)}`} />}
      </div>
      {!stay.slabs_ready && !ended && <p className="ldg-note ldg-warn">The GST slabs of a room night are not set yet: set them under Settings › Room types &amp; rates before the nights are posted.</p>}
      {(!ended || held > 0) && (
        <SectionCard icon="check" title="Next step">
          <div className="form-actions bz-start">
            {stay.status === "reserved" && can("lodging.create") && <button type="button" className="button" onClick={() => setDialog({ kind: "checkin" })}><Icon name="check" size={15} /> Check in</button>}
            {stay.status === "in_house" && can("lodging.create") && <button type="button" className="button" onClick={() => setDialog({ kind: "checkout" })}><Icon name="check" size={15} /> Check out</button>}
            {stay.status === "in_house" && can("lodging.create") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "charge" })}><Icon name="plus" size={15} /> Add a charge</button>}
            {stay.status === "in_house" && can("lodging.create") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "change" })}><Icon name="edit" size={15} /> Extend or move</button>}
            {stay.status === "in_house" && !stay.day_use && !stay.group && biz.locations.length > 1 && can("lodging.create") && can("sales.create") && (
              <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "property" })}><Icon name="home" size={15} /> Move to another property</button>
            )}
            {stay.status === "reserved" && can("lodging.create") && <button type="button" className="button button-secondary" onClick={() => navigate(biz.path(`lodging-stays/new?edit=${stay.id}`))}><Icon name="edit" size={15} /> Change</button>}
            {["reserved", "in_house"].includes(stay.status) && money && can("lodging.create") && can("sales.edit") && (
              <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "receipt", purpose: "advance" })}><Icon name="money" size={15} /> Take an advance</button>
            )}
            {stay.status === "in_house" && money && can("lodging.create") && can("sales.edit") && (
              <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "receipt", purpose: "deposit" })}><Icon name="wallet" size={15} /> Take a deposit</button>
            )}
            {stay.status === "reserved" && can("lodging.cancel") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "cancel" })}>Cancel</button>}
            {ended && held > 0 && can("lodging.refund") && <button type="button" className="button" onClick={() => setDialog({ kind: "refund" })}><Icon name="wallet" size={15} /> Hand back {biz.exact(held)}</button>}
          </div>
        </SectionCard>
      )}
      <SectionCard icon="user" title="The stay">
        <dl className="ldg-facts">
          <div className="ldg-fact"><dt>Guest</dt><dd>{stay.guest_name}{stay.guest_phone ? ` · ${stay.guest_phone}` : ""}</dd></div>
          <div className="ldg-fact"><dt>Billed to</dt><dd>{stay.bill_to_name ? `${stay.bill_to_name}${stay.bill_to_gstin ? ` · GSTIN ${stay.bill_to_gstin}` : ""}` : "The guest"}</dd></div>
          <div className="ldg-fact"><dt>Booked by</dt><dd>{wordOf(SOURCES, stay.source)}{stay.source === "ota" ? ` · ${stay.ota_name} ${stay.ota_booking_id}` : ""}</dd></div>
          <div className="ldg-fact"><dt>Guests</dt><dd>{partyWords(stay.adults, stay.children)}{Number(stay.extra_beds) ? ` · ${stay.extra_beds} extra bed` : ""}</dd></div>
          {money && <div className="ldg-fact"><dt>Rates a night (before GST)</dt><dd>{stay.agreed_rate ? `${RATE_KINDS.agreed} ${biz.exact(stay.agreed_rate)}` : `${biz.exact(stay.rack_rate)}${stay.weekend_rate ? `, weekend ${biz.exact(stay.weekend_rate)}` : ""}`}
            {stay.extra_adult_rate ? ` · extra adult ${biz.exact(stay.extra_adult_rate)}` : ""}{stay.child_rate ? ` · child ${biz.exact(stay.child_rate)}` : ""}{stay.extra_bed_rate ? ` · extra bed ${biz.exact(stay.extra_bed_rate)}` : ""}</dd></div>}
          {stay.checked_in_at && <div className="ldg-fact"><dt>Checked in</dt><dd>{atWords(stay.checked_in_at, biz)} by {stay.checked_in_by_name}</dd></div>}
          {stay.checked_out_at && <div className="ldg-fact"><dt>Checked out</dt><dd>{atWords(stay.checked_out_at, biz)} by {stay.checked_out_by_name}</dd></div>}
          {stay.cancelled_at && <div className="ldg-fact"><dt>{stay.status === "no_show" ? "No-show" : "Cancelled"}</dt><dd>{atWords(stay.cancelled_at, biz)} by {stay.cancelled_by_name} · {stay.cancel_reason}</dd></div>}
          {stay.moved_from && <div className="ldg-fact"><dt>Moved from</dt><dd><Link to={biz.path(`lodging-stays/${stay.moved_from.id}`)}>{stay.moved_from.stay_no}</Link> · {stay.moved_from.location_name}</dd></div>}
          {stay.moved_to && <div className="ldg-fact"><dt>Moved to</dt><dd><Link to={biz.path(`lodging-stays/${stay.moved_to.id}`)}>{stay.moved_to.stay_no}</Link> · {stay.moved_to.location_name}</dd></div>}
          {stay.group && <div className="ldg-fact"><dt>Group booking</dt><dd><Link to={biz.path(`lodging-groups/${stay.group.id}`)}>{stay.group.group_no} · {stay.group.name}</Link></dd></div>}
          {stay.plan && <div className="ldg-fact"><dt>Rate plan</dt><dd>{stay.plan.name} · {wordOf(MEAL_PLANS, stay.plan.meal_plan)}{stay.plan.meal_item ? ` (meals billed as ${stay.plan.meal_item})` : ""}{stay.plan.refundable ? "" : " · not refundable"}</dd></div>}
          {stay.discount_percent && <div className="ldg-fact"><dt>Discount</dt><dd>{Number(stay.discount_percent)}% · {stay.discount_reason}</dd></div>}
          {stay.day_use && <div className="ldg-fact"><dt>Day use</dt><dd>{atWords(stay.day_from, biz, { today: false })} to {atWords(stay.day_until, biz, { today: false })} ({stay.day_hours} hours)</dd></div>}
          {(stay.arrived_from || stay.going_to || stay.purpose) && <div className="ldg-fact"><dt>From, to, why</dt><dd>{[stay.arrived_from, stay.going_to, stay.purpose].map((x) => x || "—").join(" · ")}</dd></div>}
          {stay.notes && <div className="ldg-fact"><dt>Notes</dt><dd>{stay.notes}</dd></div>}
        </dl>
      </SectionCard>
      {["reserved", "in_house"].includes(stay.status) && !stay.day_use && (money || stay.policy) && <PolicySection stay={stay} />}
      <SectionCard flush icon="users" title="Occupants" description={stay.guests.length ? (stay.ids ? undefined : "Their ID details are for those who check guests in.") : "Recorded at check-in: every occupant, not only the one who booked."}
        actions={stay.status === "in_house" && can("lodging.create") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "occupant" })}><Icon name="user-plus" size={14} /> Add an occupant</button>}>
        {stay.guests.length > 0 && (
          <DataGrid variant="compact" id="lodging-stay-guests" caption="Occupants" rows={stay.guests} rowKey={(g) => g.id} rowNoun={["occupant", "occupants"]} columns={[
            { key: "name", header: "Name", value: (g) => g.full_name, mobile: "title", pin: true,
              render: (g) => <span className="bz-two-line"><span>{g.full_name}</span><small className="muted">{[g.child ? "child" : "adult", g.gender, g.age !== null && g.age !== undefined ? `${g.age} yrs` : null].filter(Boolean).join(" · ")}</small></span> },
            { key: "nationality", header: "Nationality", value: (g) => g.nationality },
            { key: "id", header: "Photo ID", value: (g) => idWords(g.id_kind, g.id_ref), mobile: "show",
              render: (g) => (g.foreigner ? <span className="bz-two-line"><span>{idWords(g.id_kind, g.id_ref)}</span><small className="muted">{[g.visa_type ? `${g.visa_type}${g.visa_no ? ` ${g.visa_no}` : ""}` : null,
                g.arrived_india_on ? `in India from ${dateWords(g.arrived_india_on)}` : null, g.next_destination ? `next: ${g.next_destination}` : null].filter(Boolean).join(" · ")}</small></span> : idWords(g.id_kind, g.id_ref)) },
            foreigners.length > 0 && { key: "frro", header: "Form-III", value: (g) => (g.foreigner ? g.frro_arrival_ack || "" : ""),
              render: (g) => (!g.foreigner ? <span className="muted">—</span> : <span className="bz-two-line"><span className={g.frro_arrival_ack ? "ldg-done" : "ldg-due"}>Arrival: {g.frro_arrival_ack || "to report"}</span>
                <small className="muted">Departure: {g.frro_departure_ack || (g.departed_at ? "to report" : "after check-out")}</small></span>) },
            { key: "arrived", header: "Arrived", type: "datetime", value: (g) => g.arrived_at, render: (g) => atWords(g.arrived_at, biz), defaultHidden: true },
            stay.guests.some((g) => g.departed_at) && { key: "left", header: "Left", type: "datetime", value: (g) => g.departed_at, render: (g) => (g.departed_at ? atWords(g.departed_at, biz) : "") },
            stay.status === "in_house" && can("lodging.create") && { key: "actions", header: "", type: "actions",
              render: (g) => (g.departed_at ? null : <button type="button" className="link-button" onClick={() => setDialog({ kind: "leave", guest: g })}>Leaves</button>) },
          ].filter(Boolean)} />
        )}
        {foreigners.some((g) => !g.frro_arrival_ack || (g.departed_at && !g.frro_departure_ack)) && can("lodging.create") && (
          <p className="ldg-note">Form-III: each foreign guest is reported within 24 hours of arrival and of departure, on <Link to={biz.path("lodging-form-iii")}>Foreign guests (Form-III)</Link>.</p>
        )}
      </SectionCard>
      {money && (
        <SectionCard flush icon="receipt" title="Folio" description="Every night at its own rate, with the GST slab its value decides; extras at their item's slab.">
          <DataGrid variant="compact" id="lodging-stay-folio" caption="Folio" rows={folioRows} rowKey={(x) => x.key} currency={biz.symbol} rowNoun={["charge", "charges"]}
            rowClassName={(x) => (x.state === "voided" ? "dg-tone-muted" : x.state === "to_post" ? "dg-tone-warning" : "")} columns={[
              { key: "label", header: "Charge", value: (x) => x.label, mobile: "title", pin: true,
                render: (x) => <span className="bz-two-line"><span>{x.label}</span><small className="muted">{x.kind === "room_night" ? RATE_KINDS[x.rate_kind] : ["extra", "goods"].includes(x.kind) ? `${Number(x.quantity)} × ${biz.exact(x.unit_price)}` : CHARGE_KINDS[x.kind] || ""}{Number(x.discount) > 0 ? ` · discount ${biz.exact(x.discount)}` : ""}{x.void_reason ? ` · voided: ${x.void_reason}` : ""}</small></span> },
              { key: "net", header: "Value", type: "money", exact: true, value: (x) => Number(x.net) },
              { key: "tax_rate", header: "GST", value: (x) => `${Number(x.tax_rate)}%`, align: "right" },
              { key: "tax", header: "GST amount", type: "money", exact: true, value: (x) => Number(x.tax) },
              { key: "total", header: "With GST", type: "money", exact: true, value: (x) => (x.state === "voided" ? 0 : Number(x.net) + Number(x.tax)), total: "sum" },
              { key: "state", header: "State", value: (x) => STATE_WORDS[x.state][0], mobile: "show", render: (x) => <Badge tone={STATE_WORDS[x.state][1]} label={STATE_WORDS[x.state][0]} /> },
              split && { key: "folio", header: "Folio", value: (x) => folioName(stay, x.folio_id) },
              ((can("lodging.approve") && stay.status === "in_house") || canMove) && { key: "actions", header: "", type: "actions",
                render: (x) => (x.state === "posted" ? (
                  <span className="ldg-row-actions">
                    {can("lodging.approve") && <button type="button" className="link-button" onClick={() => setDialog({ kind: "void", charge: x })}>Void</button>}
                    {canMove && x.kind !== "cancellation" && <button type="button" className="link-button" onClick={() => setDialog({ kind: "move", charge: x })}>Move</button>}
                  </span>
                ) : null) },
            ].filter(Boolean)} />
        </SectionCard>
      )}
      {money && (split || ["reserved", "in_house"].includes(stay.status)) && <FoliosSection stay={stay} onOpen={() => setDialog({ kind: "folio" })} onRoute={() => setDialog({ kind: "routing" })} />}
      {money && (stay.receipts.length > 0 || stay.bill) && (
        <SectionCard icon="wallet" title="Money" description="Advances and deposits are held for the stay's own bill: they pay it first at check-out, and what is left goes back.">
          <dl className="ldg-facts">
            {stay.bill && (
              <div className="ldg-fact"><dt><button type="button" className="link-button mono" title="Print the tax invoice" onClick={printBill}>{stay.bill.document_no}</button></dt>
                <dd>{biz.exact(stay.bill.total)}{Number(stay.bill.returned) > 0 ? ` · credited ${biz.exact(stay.bill.returned)}` : ""} · paid {biz.exact(Number(stay.bill.paid) - Number(stay.bill.refunded))} · <strong>due {biz.exact(Math.max(0, Number(stay.bill.due)))}</strong>
                  {stay.bill.buyer_gstin ? ` · ${stay.bill.contact_name}, GSTIN ${stay.bill.buyer_gstin}` : ""}</dd></div>
            )}
            {stay.receipts.map((r) => (
              <div key={r.id} className="ldg-fact">
                <dt>{r.purpose === "deposit" ? "Deposit" : "Advance"} {r.collection_no}</dt>
                <dd>{biz.exact(r.amount)} · applied {biz.exact(r.used)} · handed back {biz.exact(r.refunded)} · <strong>held {biz.exact(r.free)}</strong></dd>
              </div>
            ))}
          </dl>
          {stay.receipts.some((r) => r.refunds.length > 0) && (
            <ul className="ldg-refunds">
              {stay.receipts.flatMap((r) => r.refunds.map((f) => ({ ...f, collection_no: r.collection_no, purpose: r.purpose }))).map((f) => (
                <li key={f.id}>
                  <span>{f.refund_no} · {f.purpose === "deposit" ? "deposit" : "advance"} {biz.exact(f.amount)} handed back · {atWords(f.created_at, biz)} · approved by {f.approved_by_name} — {f.reason}</span>
                  <button type="button" className="chip-button" onClick={() => printMoneyBack(biz, stay, f)}><Icon name="print" size={13} /> Slip</button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      <ProfileSection stay={stay} onEdit={() => setDialog({ kind: "profile" })} />
      <SectionCard flush icon="history" title="History">
        <DataGrid variant="compact" id="lodging-stay-history" caption="History of this stay" rows={stay.events} rowKey={(e) => e.id} rowNoun={["change", "changes"]} columns={[
          { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle", render: (e) => atWords(e.created_at, biz) },
          { key: "to_status", header: "Status", value: (e) => STATUS_WORDS[e.to_status] || "", mobile: "title",
            render: (e) => (e.to_status ? <Badge tone={e.to_status === "in_house" ? "success" : "neutral"} label={STATUS_WORDS[e.to_status] || e.to_status} /> : <span className="muted small">Note</span>) },
          { key: "note", header: "Note", value: (e) => e.note || "", mobile: "show" },
          { key: "by", header: "By", value: (e) => e.by_name },
        ]} />
      </SectionCard>
      {dialog?.kind === "checkin" && <CheckInDialog stay={stay} onClose={() => setDialog(null)} onSaved={(s) => refresh(`${s.stay_no}: checked in to room ${s.room_no}.`)} />}
      {dialog?.kind === "checkout" && <CheckOutDialog stay={stay} onClose={() => setDialog(null)} onSaved={(s) => refresh(s.document_no ? `${s.stay_no}: checked out and billed (${s.document_no}).` : `${s.stay_no}: checked out.`)} />}
      {dialog?.kind === "folio" && <OpenFolioDialog stay={stay} onClose={() => setDialog(null)} onSaved={() => refresh("Folio opened.")} />}
      {dialog?.kind === "routing" && <RoutingDialog stay={stay} onClose={() => setDialog(null)} onSaved={() => refresh("Routing saved.")} />}
      {dialog?.kind === "move" && <MoveChargeDialog stay={stay} charge={dialog.charge} onClose={() => setDialog(null)} onSaved={() => refresh("Charge moved.")} />}
      {dialog?.kind === "occupant" && <AddOccupantDialog stay={stay} onClose={() => setDialog(null)} onSaved={() => refresh("Occupant added.")} />}
      {dialog?.kind === "leave" && <LeaveDialog stay={stay} guest={dialog.guest} onClose={() => setDialog(null)} onSaved={() => refresh(`${dialog.guest.full_name} left the stay.`)} />}
      {dialog?.kind === "profile" && <ProfileDialog stay={stay} onClose={() => setDialog(null)} onSaved={() => refresh("Profile saved.")} />}
      {dialog?.kind === "charge" && <ChargeDialog stay={stay} onClose={() => setDialog(null)} onSaved={() => refresh("Added to the folio.")} />}
      {dialog?.kind === "void" && <VoidDialog stay={stay} charge={dialog.charge} onClose={() => setDialog(null)} onSaved={() => refresh("Charge voided.")} />}
      {dialog?.kind === "property" && <MovePropertyDialog stay={stay} onClose={() => setDialog(null)} onSaved={(s) => { setDialog(null); toast.success(`Moved: ${s.stay_no} at ${s.location_name}.`); navigate(biz.path(`lodging-stays/${s.id}`)); }} />}
      {dialog?.kind === "change" && <ChangeStayDialog stay={stay} onClose={() => setDialog(null)} onSaved={(s) => refresh(`${s.stay_no} changed.`)} />}
      {dialog?.kind === "receipt" && <ReceiptDialog stay={stay} purpose={dialog.purpose} onClose={() => setDialog(null)} onSaved={() => refresh(dialog.purpose === "deposit" ? "Deposit taken." : "Advance taken.")} />}
      {dialog?.kind === "cancel" && <CancelDialog stay={stay} onClose={() => setDialog(null)} onSaved={(s) => refresh(`${s.stay_no} ${s.status === "no_show" ? "marked a no-show" : "cancelled"}.`)} />}
      {dialog?.kind === "refund" && <RefundDialog stay={stay} held={held} onClose={() => setDialog(null)} onSaved={(r) => {
        for (const f of r.refunds.filter((x) => !x.repeated)) printMoneyBack(biz, r.stay, f);
        refresh(`${biz.exact(r.refunds.reduce((s, f) => s + Number(f.amount), 0))} handed back.`);
      }} />}
    </div>
  );
}
