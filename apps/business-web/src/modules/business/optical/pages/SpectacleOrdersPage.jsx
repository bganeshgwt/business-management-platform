import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, duration } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { whatsappLink } from "../../retail/pages/retail";
import SpectacleOrderDialog from "./SpectacleOrderDialog";
import { STATUSES, orderMessage, stageFor } from "./optical";
import "../styles/optical.css";

// Spectacle orders: the day's board. Open orders with a chip for today's
// due, the ones ready to collect, the overdue ones and each step (booked, at
// the lab, in the workshop, at the quality check), each row with WhatsApp;
// all orders by date; and booking a new one. An order opens its job card.

const CHIPS = [
  ["open", "All open"], ["due_today", "Due today"], ["ready", "Ready to collect"], ["overdue", "Overdue"],
  ["booked", "Booked"], ["at_lab", "At the lab"], ["in_workshop", "In the workshop"], ["quality_check", "Quality check"],
];
const paramsFor = (chip) => (chip === "open" ? {} : ["due_today", "ready", "overdue"].includes(chip) ? { [chip]: "true" } : { status: chip });

export default function SpectacleOrdersPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState("open");
  const [chip, setChip] = useState("open");
  const [counts, setCounts] = useState(null);
  const [version, setVersion] = useState(0);
  const open = useServerList("optical/orders/open", { gridId: "optical-orders-open", params: paramsFor(chip) });
  const all = useServerList("optical/orders", { gridId: "optical-orders", period: true });
  const list = view === "open" ? open : all;
  const canBook = biz.can("optical.create") && biz.can("sales.create");
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  const today = businessToday(biz.business.timezone);
  const [booking, setBooking] = useState(() => (params.get("new") === "1" && canBook ? { prescriptionId: params.get("prescription") || null } : null));
  useEffect(() => {
    if (params.get("new")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); next.delete("prescription"); return next; }, { replace: true });
  }, [params, setParams]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "optical/orders/counts", undefined, controller.signal).then(setCounts).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);

  const tell = (o) => {
    if (o.customer_phone) window.open(whatsappLink(o.customer_phone, orderMessage(biz, o, stageFor(o.status))), "_blank", "noopener");
    businessWrite(biz.id, `optical/orders/${o.id}/messages`, { channel: "whatsapp", stage: stageFor(o.status) }).catch((err) => toast.error(getErrorMessage(err)));
  };

  const columns = useMemo(() => [
    { key: "order_no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Booked", type: "datetime", value: (o) => o.created_at, defaultHidden: view === "open" },
    { key: "customer", header: "Customer", value: (o) => `${o.customer_name} ${o.customer_phone || ""}`, mobile: "show",
      render: (o) => <span className="bz-two-line"><span>{o.customer_name}</span>{o.customer_phone && <small className="muted">{o.customer_phone}</small>}</span> },
    { key: "frame", header: "Frame and lenses", value: (o) => `${o.frame || ""} ${o.lenses || ""}`, mobile: "subtitle",
      render: (o) => <span className="bz-two-line"><span>{o.frame || "—"}</span><small className="muted">{o.lenses || ""}{o.remake_of_no ? ` · remake of ${o.remake_of_no}` : ""}</small></span> },
    { key: "status", header: "Status", type: "status", value: (o) => STATUSES[o.status]?.label || o.status, mobile: "show",
      render: (o) => <span className="bz-two-line"><Badge tone={STATUSES[o.status]?.tone} label={STATUSES[o.status]?.label || o.status} />
        {o.status_since && !["delivered", "cancelled"].includes(o.status) && <small className="muted">for {duration(o.status_since)}</small>}</span>,
      filter: "select", filterOptions: Object.values(STATUSES).map((s) => ({ value: s.label, label: s.label })) },
    { key: "promised_on", header: "Promised for", type: "date", value: (o) => o.promised_on,
      render: (o) => <span className={o.overdue ? "bz-minus" : ""}>{o.promised_on === today ? "Today" : dateShort(o.promised_on, { year: true })}{o.overdue ? " · late" : ""}</span> },
    { key: "made", header: "Made", value: (o) => (o.made_at === "lab" ? o.lab_name : "In-house"),
      render: (o) => (o.made_at === "lab" ? <span className="bz-two-line"><span>{o.lab_name}</span>{o.lab_order_no && <small className="muted mono">{o.lab_order_no}</small>}</span> : "In our workshop") },
    money && { key: "total", header: "Total", type: "money", exact: true, value: (o) => Number(o.total), total: "sum" },
    money && { key: "advance", header: "Advance", type: "money", exact: true, value: (o) => (o.advance === null ? null : Number(o.advance)), total: "sum",
      render: (o) => (o.advance === null ? "—" : o.advance_to_refund ? <span className="bz-two-line"><span>{biz.exact(o.advance)}</span><small className="bz-minus">{biz.exact(o.advance_left)} to refund</small></span> : biz.exact(o.advance)) },
    money && view === "open" && { key: "balance", header: "To pay", type: "money", exact: true, value: (o) => (o.balance === null ? null : Number(o.balance)), total: "sum", mobile: "show" },
    { key: "location", header: "Location", value: (o) => o.location_name, defaultHidden: !many },
    view === "open" && { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); tell(o); }} title="Message the customer on WhatsApp"><Icon name="message" size={14} /> WhatsApp</button>
      </span>
    ) },
  ].filter(Boolean), [biz, view, money, many, today]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Spectacle orders"
        description="Each order's job card: the prescription, the frame and lenses, the lab or the workshop, the quality check and the promised day. The bill is made when the spectacles are delivered, with the advance taken off."
        primary={canBook && <button type="button" className="button" onClick={() => setBooking({})}><Icon name="plus" size={16} /> Book an order</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="clipboard" title={view === "open" ? "Open orders" : "All orders"}
        actions={<Segmented label="Show" options={[{ value: "open", label: "Open orders" }, { value: "all", label: "All orders by date" }]} value={view} onChange={setView} />}>
        {view === "open" && (
          <div className="fe-chips" role="group" aria-label="Open orders">
            {CHIPS.map(([value, label]) => {
              const n = counts ? counts[value] : null;
              if (n === 0 && !["open", "due_today", "ready", "overdue", chip].includes(value)) return null;
              return (
                <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""} ${value === "overdue" && n ? "is-alert" : ""}`}
                  onClick={() => setChip(value)}>{label}{n !== null && n !== undefined && <b>{n}</b>}</button>
              );
            })}
          </div>
        )}
        <DataGrid key={view} {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Order, customer, phone, frame or lab order" }} caption="Spectacle orders"
          columns={columns} currency={biz.symbol} rowNoun={["order", "orders"]} onRowClick={(o) => navigate(biz.path(`spectacle-orders/${o.id}`))}
          rowClassName={(o) => (o.overdue ? "dg-tone-danger" : o.status === "ready" ? "dg-tone-success" : o.status === "quality_check" ? "dg-tone-warning" : ["delivered", "cancelled"].includes(o.status) ? "dg-tone-muted" : "")}
          toolbar={view === "all" ? <PeriodFilter list={all} /> : undefined}
          empty={view === "open" ? "No open spectacle orders here" : "No spectacle orders in these dates"}
          emptyHint={view === "open" ? (canBook ? "Book an order from a customer's prescription." : undefined) : "Pick other dates."} emptyIcon="clipboard" />
      </SectionCard>
      {booking && <SpectacleOrderDialog prescriptionId={booking.prescriptionId || null} onClose={() => setBooking(null)}
        onSaved={(o) => { setBooking(null); setVersion((n) => n + 1); toast.success(`Order ${o.order_no} booked.`); navigate(biz.path(`spectacle-orders/${o.id}`)); }} />}
    </div>
  );
}
