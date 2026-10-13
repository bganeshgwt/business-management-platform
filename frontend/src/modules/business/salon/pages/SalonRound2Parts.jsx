import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import useAuth from "../../../../hooks/useAuth";
import { toast } from "../../../../services/toast";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateLong, dateShort } from "../../../../services/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
// An advance goes back by cash, UPI or bank (the business's own methods of those kinds).
const REFUND_KINDS = ["cash", "upi", "bank"];
import ManagerApproval from "./ManagerApproval";
import { approvalFor, emptyApproval } from "./approval";
import { WEEKDAYS, methodWord } from "./salon";
import { printRefundReceipt } from "./salonRound2";

// Salon round 2 (R2-SVC): the stylist's week, salon holidays, the back-bar
// products a service uses, and a client's advance handed back or moved to
// their wallet (with the refund receipt).

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (t) => (t ? String(t).slice(0, 5) : "");

// One row per weekday: as usual, a day off, or other hours.
export function WeekDialog({ resource, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const usualOff = new Set((resource.weekly_off || []).map(Number));
  const usual = resource.works_from ? `${hhmm(resource.works_from)}–${hhmm(resource.works_to)}` : "the salon's hours";
  const [days, setDays] = useState(() => [1, 2, 3, 4, 5, 6, 0].map((dow) => {
    const own = (resource.week || []).find((w) => Number(w.dow) === dow);
    return { dow, mode: own ? (own.off ? "off" : "hours") : "usual", from: hhmm(own?.works_from) || hhmm(resource.works_from) || "10:00", to: hhmm(own?.works_to) || hhmm(resource.works_to) || "19:00" };
  }));
  const set = (dow, changes) => setDays((all) => all.map((d) => (d.dow === dow ? { ...d, ...changes } : d)));
  const submit = () => businessWrite(biz.id, `salon/staff/${resource.id}/week`, {
    days: days.filter((d) => d.mode !== "usual").map((d) => (d.mode === "off" ? { dow: d.dow, off: true } : { dow: d.dow, off: false, worksFrom: d.from, worksTo: d.to })),
  }, "put");
  return (
    <FormDialog title={`${resource.name}'s week`} icon="clock" width={640} submitLabel="Save the week" onSubmit={submit} onClose={onClose} onSaved={onSaved}
      description={`Each weekday is ${usual}${usualOff.size ? `, off on ${[...usualOff].map((d) => WEEKDAYS[d]).join(", ")}` : ""} unless set here. The calendar greys out the rest and refuses bookings outside it; a manager can let one through.`}>
      <div className="field-wide sw-week-edit" role="group" aria-label="Weekly schedule">
        {days.map((d) => (
          <div key={d.dow} className="sw-week-row">
            <strong>{DAY_NAMES[d.dow]}</strong>
            <select aria-label={`${DAY_NAMES[d.dow]}`} value={d.mode} onChange={(e) => set(d.dow, { mode: e.target.value })}>
              <option value="usual">{usualOff.has(d.dow) ? "Usual (off)" : `Usual (${usual})`}</option>
              <option value="hours">Other hours</option>
              <option value="off">Day off</option>
            </select>
            {d.mode === "hours" && (
              <span className="sw-row">
                <input type="time" aria-label={`${DAY_NAMES[d.dow]} from`} required value={d.from} onChange={(e) => set(d.dow, { from: e.target.value })} />
                <span className="muted">to</span>
                <input type="time" aria-label={`${DAY_NAMES[d.dow]} till`} required value={d.to} onChange={(e) => set(d.dow, { to: e.target.value })} />
              </span>
            )}
          </div>
        ))}
      </div>
    </FormDialog>
  );
}

// Salon holidays: the salon (or one location) is closed; nothing is booked.
export function Holidays({ onNotice }) {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const today = businessToday(biz.business.timezone);
  const list = useServerList("salon/holidays", { gridId: "salon-holidays", params: { from: today, to: `${Number(today.slice(0, 4)) + 1}-12-31` } });
  const [adding, setAdding] = useState(false);
  const canEdit = biz.can("settings.edit");
  const cancel = async (h) => {
    if (!(await confirm({ title: `Open on ${dateLong(h.day)} after all?`, message: `${h.name} is taken off; the calendar takes bookings that day again.`, confirmLabel: "Open that day", cancelLabel: "Keep the holiday" }))) return;
    try {
      await businessWrite(biz.id, `salon/holidays/${h.id}/cancel`, {});
      toast.success(`${h.name} removed`);
      list.reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const columns = useMemo(() => [
    { key: "day", header: "Date", type: "date", value: (h) => h.day, mobile: "subtitle", render: (h) => dateLong(h.day) },
    { key: "name", header: "Holiday", value: (h) => h.name, mobile: "title", pin: true },
    { key: "location_name", header: "Where", value: (h) => h.location_name || "Every location", mobile: "show", defaultHidden: biz.locations.length < 2 },
    { key: "created_by_name", header: "Added by", value: (h) => h.created_by_name, defaultHidden: true },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (h) => <button type="button" className="chip-button" onClick={() => cancel(h)}>Remove</button> },
  ].filter(Boolean), [canEdit, biz.locations.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="calendar" title="Holidays coming" description="Festivals and closed days. The calendar shows them and takes no bookings."
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add a holiday</button>}>
        <DataGrid {...list.gridProps} caption="Holidays" columns={columns} rowNoun={["holiday", "holidays"]} empty="No holidays coming" emptyHint="Add Diwali, Pongal or a day the salon is closed." emptyIcon="calendar" />
      </SectionCard>
      {adding && <HolidayDialog onClose={() => setAdding(false)} onSaved={(h) => { setAdding(false); onNotice(`${h.name} on ${dateLong(h.day)} added. Nothing can be booked that day.`); list.reload(); }} />}
    </>
  );
}

function HolidayDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ day: today, name: "", locationId: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Add a holiday" icon="calendar" width={520} submitLabel="Add holiday" onClose={onClose} onSaved={onSaved}
      description="Bookings already made for that day must be moved first."
      onSubmit={() => businessWrite(biz.id, "salon/holidays", { day: form.day, name: form.name, locationId: form.locationId || null })}>
      <Field label="Date"><input required type="date" min={today} value={form.day} onChange={set("day")} /></Field>
      <Field label="Holiday"><input required maxLength={100} value={form.name} onChange={set("name")} placeholder="Diwali" /></Field>
      {locations.length > 1 && (
        <Field label="Where">
          <select value={form.locationId} onChange={set("locationId")}><option value="">Every location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
    </FormDialog>
  );
}

// The products one service uses, in each product's own stock unit.
export function RecipeDialog({ service, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true&kind=goods"]);
  const [rows, setRows] = useState(null);
  const [cost, setCost] = useState(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `salon/services/${service.id}/products`, {}, controller.signal)
      .then((r) => { setCost(r.cost); setRows(r.products.map((p) => ({ key: newKey(), skuId: String(p.sku_id), quantity: String(Number(p.quantity)), unitCost: Number(p.unit_cost) }))); })
      .catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, service.id]);
  const goods = (options?.["catalog?active=true&kind=goods"] || []).filter((s) => s.tracking !== "serial");
  const skuOf = (skuId) => goods.find((g) => String(g.id) === String(skuId));
  const setRow = (key, changes) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...changes } : r)));
  return (
    <FormDialog title={`Products used in ${service.label}`} icon="layers" width={680} submitLabel="Save" onClose={onClose} onSaved={onSaved} disabled={!options || !rows}
      description="Billing this service takes these out of the salon's stock at the bill's location. The cost is each product's latest purchase price (before GST)."
      onSubmit={() => businessWrite(biz.id, `salon/services/${service.id}/products`, { products: rows.filter((r) => r.skuId).map((r) => ({ skuId: r.skuId, quantity: r.quantity })) }, "put")}>
      <FormError message={error || loadError} />
      <div className="field-wide sw-stack">
        {(rows || []).map((r) => {
          const sku = skuOf(r.skuId);
          return (
            <div key={r.key} className="sw-row">
              <div style={{ flex: "1 1 240px" }}>
                <SearchPicker aria-label="Product" value={sku || null} options={goods} getKey={(g) => g.id} getLabel={(g) => g.label}
                  getDescription={(g) => `${g.code || ""} · ${quantity(g.stock, g.unit)} in stock`} placeholder="Colour, developer, mask…"
                  onChange={(g) => setRow(r.key, { skuId: g ? String(g.id) : "" })} />
              </div>
              <input aria-label={`Quantity of ${sku?.label || "product"}`} required type="number" min="0.001" step="0.001" style={{ width: "7rem" }} value={r.quantity}
                onChange={(e) => setRow(r.key, { quantity: e.target.value })} />
              <span className="muted">{sku?.unit || ""}</span>
              <button type="button" className="link-button danger" onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>Remove</button>
            </div>
          );
        })}
        <div className="sw-row">
          <button type="button" className="button button-secondary button-sm" onClick={() => setRows((all) => [...(all || []), { key: newKey(), skuId: "", quantity: "" }])}>
            <Icon name="plus" size={14} /> Add a product
          </button>
        </div>
        {rows && !rows.length && <p className="sw-note">No products: billing {service.label} takes nothing from stock.</p>}
        {rows && rows.length > 0 && cost !== null && <p className="sw-note">As saved: about {biz.exact(cost)} of products a service, at the latest purchase prices.</p>}
      </div>
    </FormDialog>
  );
}

// --- A client's advance --------------------------------------------------------------------

// deposit: one of the client card's deposits ({ id, collection_no, unused, held }).
export function AdvanceDialog({ client, deposit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [requestKey] = useState(newKey);
  const [mode, setMode] = useState(deposit.held ? "wallet" : "cash");
  const [form, setForm] = useState({ amount: String(Number(deposit.unused)), method: "cash", reference: "" });
  const methods = usePaymentMethods();
  const kind = methods.kindOf(form.method, REFUND_KINDS);
  const [approval, setApproval] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`${client.name}'s advance ${deposit.collection_no}`} icon="wallet" width={600} onClose={onClose} onSaved={onSaved}
      submitLabel={mode === "wallet" ? "Move to the wallet" : "Refund"}
      description={`${biz.exact(deposit.unused)} left of ${biz.exact(deposit.amount)}${deposit.held ? " · held for a booking still to come" : " · the client's advance for any bill"}.`}
      onSubmit={() => businessWrite(biz.id, `salon/clients/${client.id}/advance-refund`, {
        mode, collectionId: deposit.id, requestKey, ...approvalFor(approval, user?.id),
        ...(mode === "cash" ? { amount: form.amount, ...methods.body(form.method, REFUND_KINDS), reference: form.reference || null } : {}),
      })}>
      {deposit.held && (
        <Field label="What to do" wide hint={mode === "wallet" ? "Usable on any bill; the booking then keeps no deposit, so a no-show charges nothing." : "Cash, UPI or bank; a receipt prints."}>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="wallet">Move to the client's wallet</option>
            <option value="cash">Hand it back</option>
          </select>
        </Field>
      )}
      {mode === "cash" && (
        <>
          <Field label={`Amount (${biz.symbol})`} hint={`Up to ${biz.exact(deposit.unused)}`}>
            <input required type="number" min="0.01" max={Number(deposit.unused)} step="0.01" value={form.amount} onChange={set("amount")} />
          </Field>
          <Field label="Paid back by">
            <select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
          </Field>
          {kind !== "cash" && <Field label="Reference" wide><input required maxLength={100} value={form.reference} onChange={set("reference")} placeholder="UPI / bank reference" /></Field>}
        </>
      )}
      <ManagerApproval permission="sales.refund" value={approval} onChange={setApproval} reasonLabel="Reason"
        reasonPlaceholder={mode === "wallet" ? "e.g. Wants to use it for her mother's visit" : "e.g. Moving to another city"}
        note="A manager approves with their PIN; it is kept in the activity log." />
    </FormDialog>
  );
}

// The client card's advance section: each receipt with money left, and the refunds made.
export function ClientAdvances({ biz, data, onChanged }) {
  const [open, setOpen] = useState(null);
  const canRefund = biz.can("sales.edit");
  const deposits = data.deposits || [];
  const columns = [
    { key: "collection_no", header: "Receipt", value: (d) => d.collection_no, mobile: "title" },
    { key: "created_at", header: "Taken", type: "date", value: (d) => d.created_at, render: (d) => dateShort(d.created_at), mobile: "subtitle" },
    { key: "unused", header: "Left", type: "money", exact: true, value: (d) => Number(d.unused), mobile: "show" },
    { key: "state", header: "", type: "status", value: (d) => (d.held ? "held" : "advance"),
      render: (d) => (d.held ? <Badge tone="warning" label="Held for a booking" /> : <Badge tone="success" label={d.released ? "In the wallet" : "Advance"} />) },
    canRefund && { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => <button type="button" className="chip-button" onClick={() => setOpen(d)}>{d.held ? "Refund / wallet" : "Refund"}</button> },
  ].filter(Boolean);
  const refundColumns = [
    { key: "refund_no", header: "Refund", value: (r) => r.refund_no, mobile: "title" },
    { key: "created_at", header: "Date", type: "date", value: (r) => r.created_at, render: (r) => dateShort(r.created_at), mobile: "subtitle" },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (r) => Number(r.amount), mobile: "show" },
    { key: "method", header: "By", value: (r) => r.method_name || methodWord(r.method) },
    { key: "approved_by_name", header: "Approved by", value: (r) => r.approved_by_name, defaultHidden: true },
    { key: "print", header: "", label: "Print", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => printRefundReceipt(biz, r, data.contact.name)}><Icon name="print" size={13} /> Receipt</button> },
  ];
  return (
    <div className="sw-stack">
      <DataGrid id="salon-client-advances" variant="compact" caption="Advances and deposits" columns={columns} rows={deposits} rowKey={(d) => d.id} currency={biz.symbol}
        rowNoun={["receipt", "receipts"]} pageSize={10} empty="No advance or deposit left" emptyIcon="wallet" />
      {(data.refunds || []).length > 0 && <strong>Refunds</strong>}
      {(data.refunds || []).length > 0 && (
        <DataGrid id="salon-client-refunds" variant="compact" caption="Refunds" columns={refundColumns} rows={data.refunds} rowKey={(r) => r.id} currency={biz.symbol}
          rowNoun={["refund", "refunds"]} pageSize={10} />
      )}
      {open && (
        <AdvanceDialog client={data.contact} deposit={open} onClose={() => setOpen(null)} onSaved={(result) => {
          setOpen(null);
          if (result.mode === "cash" && result.refund) {
            toast.success(`${result.refund.refund_no}: ${biz.exact(result.refund.amount)} refunded`, { action: { label: "Print receipt", onClick: () => printRefundReceipt(biz, result.refund, data.contact.name) }, duration: 9000 });
            printRefundReceipt(biz, result.refund, data.contact.name);
          } else toast.success(`${open.collection_no} is now in ${data.contact.name}'s wallet`);
          onChanged();
        }} />
      )}
    </div>
  );
}
