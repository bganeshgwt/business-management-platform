import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { ORDER_STATUSES, messageLink, noticeFor } from "./laundry";
import "../styles/laundry.css";

// Garment orders: the day's board. Open orders with a chip for each status
// (received, in process, partly ready, ready, partly delivered), those due
// today, the overdue, express and those with a damage claim waiting, each row
// with WhatsApp; all orders by date. An order opens with its garments.

const CHIPS = [
  ["open", "All open"], ["due_today", "Due today"], ["overdue", "Overdue"], ["ready", "Ready to collect"], ["received", "Received"], ["in_process", "In process"],
  ["part_ready", "Partly ready"], ["part_delivered", "Partly delivered"], ["express", "Express"], ["claim_open", "Claims waiting"],
];
const FLAGS = ["due_today", "overdue", "express", "claim_open"];
const paramsFor = (chip) => (chip === "open" ? {} : FLAGS.includes(chip) ? { [chip]: "true" } : { status: chip });

export default function GarmentOrdersPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [view, setView] = useState("open");
  const [chip, setChip] = useState("open");
  const [counts, setCounts] = useState(null);
  const [version, setVersion] = useState(0);
  const open = useServerList("laundry/orders/open", { gridId: "laundry-orders-open", params: paramsFor(chip) });
  const all = useServerList("laundry/orders", { gridId: "laundry-orders", period: true });
  const list = view === "open" ? open : all;
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  const today = businessToday(biz.business.timezone);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "laundry/orders/counts", undefined, controller.signal).then(setCounts).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const tell = (o) => {
    const kind = noticeFor(o.status);
    if (o.customer_phone) window.open(messageLink(biz, { ...o, due: o.balance }, kind), "_blank", "noopener");
    businessWrite(biz.id, `laundry/orders/${o.id}/notices`, { kind, channel: "whatsapp" }).then(() => setVersion((n) => n + 1)).catch((err) => toast.error(getErrorMessage(err)));
  };

  const columns = useMemo(() => [
    { key: "order_no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Taken in", type: "datetime", value: (o) => o.created_at, defaultHidden: view === "open" },
    { key: "customer", header: "Customer", value: (o) => `${o.customer_name} ${o.customer_phone || ""}`, mobile: "show",
      render: (o) => <span className="bz-two-line"><span>{o.customer_name}</span>{o.customer_phone && <small className="muted">{o.customer_phone}</small>}</span> },
    { key: "garments", header: "Garments", value: (o) => `${o.garments || ""} ${o.tags || ""}`, mobile: "subtitle",
      render: (o) => <span className="bz-two-line"><span>{o.items} {o.items === 1 ? "garment" : "garments"} · {o.pieces} {o.pieces === 1 ? "piece" : "pieces"}</span><small className="muted">{o.garments}</small></span> },
    { key: "status", header: "Status", type: "status", value: (o) => ORDER_STATUSES[o.status]?.label || o.status, mobile: "show",
      render: (o) => <span className="bz-two-line"><Badge tone={ORDER_STATUSES[o.status]?.tone} label={ORDER_STATUSES[o.status]?.label || o.status} />
        {(o.express || o.claim_open) && <small className={o.claim_open ? "bz-minus" : "muted"}>{[o.express ? "express" : null, o.claim_open ? "claim waiting" : null].filter(Boolean).join(" · ")}</small>}</span>,
      filter: "select", filterOptions: Object.values(ORDER_STATUSES).map((s) => ({ value: s.label, label: s.label })) },
    { key: "promised_on", header: "Promised for", type: "date", value: (o) => o.promised_on,
      render: (o) => <span className={o.overdue ? "bz-minus" : ""}>{o.promised_on === today ? "Today" : dateShort(o.promised_on, { year: true })}{o.overdue ? " · late" : ""}</span> },
    { key: "racks", header: "Racks", value: (o) => o.racks || "", render: (o) => (o.racks ? <span className="mono">{o.racks}</span> : <span className="muted">—</span>) },
    money && { key: "total", header: "Total", type: "money", exact: true, value: (o) => Number(o.total), total: "sum", defaultHidden: view === "open" },
    money && { key: "balance", header: "To pay", type: "money", exact: true, value: (o) => (o.balance === null ? null : Number(o.balance)), total: "sum", mobile: "show" },
    { key: "location", header: "Location", value: (o) => o.location_name, defaultHidden: !many },
    view === "open" && { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); tell(o); }} title="Message the customer on WhatsApp"><Icon name="message" size={14} /> WhatsApp</button>
      </span>
    ) },
  ].filter(Boolean), [biz, view, money, many, today]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Garment orders"
        description="Every order with its garments and their tags, through the work to the racks and the handover. The bill is made at intake or when the garments are handed over, as the shop has chosen."
        primary={biz.can("laundry.create") && <Link className="button" to={biz.path("laundry-new")}><Icon name="plus" size={16} /> New order</Link>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="clipboard" title={view === "open" ? "Open orders" : "All orders"}
        actions={<Segmented label="Show" options={[{ value: "open", label: "Open orders" }, { value: "all", label: "All orders by date" }]} value={view} onChange={setView} />}>
        {view === "open" && (
          <div className="fe-chips" role="group" aria-label="Open orders">
            {CHIPS.map(([value, label]) => {
              const n = counts ? counts[value] : null;
              if (n === 0 && !["open", "due_today", "overdue", "ready", chip].includes(value)) return null;
              return (
                <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""} ${["overdue", "claim_open"].includes(value) && n ? "is-alert" : ""}`}
                  onClick={() => setChip(value)}>{label}{n !== null && n !== undefined && <b>{n}</b>}</button>
              );
            })}
          </div>
        )}
        <DataGrid key={view} {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Order, customer, phone, tag or rack" }} caption="Garment orders"
          columns={columns} currency={biz.symbol} rowNoun={["order", "orders"]} onRowClick={(o) => navigate(biz.path(`garment-orders/${o.id}`))}
          rowClassName={(o) => (o.overdue ? "dg-tone-danger" : o.status === "ready" ? "dg-tone-success" : o.claim_open ? "dg-tone-warning" : ["delivered", "cancelled"].includes(o.status) ? "dg-tone-muted" : "")}
          toolbar={view === "all" ? <PeriodFilter list={all} /> : undefined}
          empty={view === "open" ? "No open garment orders here" : "No garment orders in these dates"}
          emptyHint={view === "open" ? (biz.can("laundry.create") ? "Take one in with New order." : undefined) : "Pick other dates."} emptyIcon="clipboard" />
      </SectionCard>
    </div>
  );
}
