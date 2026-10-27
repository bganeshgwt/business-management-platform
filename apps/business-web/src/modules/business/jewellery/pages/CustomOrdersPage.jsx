import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ORDER_STATUSES, perGram, purityMark } from "./jewellery";
import { OrderForm, OrderPanel, RATE_RULE } from "./OrderDialogs";
import "../styles/jewellery.css";

// Custom orders: pieces made to a customer's order. Booked with what to make
// and the day promised, often with an advance (money or old gold) that may fix
// the rate (bhav cut); issued to a karigar, received, hallmarked, ready, and
// delivered on the jewellery bill, which prices the grams fixed at the order's
// rate and the rest at the day's, its advances paying first. The orders past
// the day promised are listed for a call. Money shows to those who see sales.
// Opened with ?order=<id> on an order.

const CHIPS = [["open", "Open", { open: "true" }], ["late", "Past the day promised", { late: "true" }], ["ready", "Ready", { status: "ready" }],
  ["delivered", "Delivered", { status: "delivered" }], ["cancelled", "Cancelled", { status: "cancelled" }], ["all", "All", {}]];

export default function CustomOrdersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [chip, setChip] = useState("open");
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [booking, setBooking] = useState(false);
  // Opened on an order (?order=<id>).
  const [openId, setOpenId] = useState(() => params.get("order"));
  const filter = useMemo(() => CHIPS.find(([value]) => value === chip)?.[2] || {}, [chip]);
  const list = useServerList("jewellery/orders", { gridId: "jewellery-orders", params: filter });
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/items", undefined, controller.signal).then((i) => { setItems(i.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  useEffect(() => {
    if (params.get("order")) setParams((p) => { const next = new URLSearchParams(p); next.delete("order"); return next; }, { replace: true });
  }, [params, setParams]);
  const columns = useMemo(() => [
    { key: "order_no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Booked", type: "datetime", value: (o) => o.created_at, defaultHidden: true },
    { key: "customer", header: "Customer", value: (o) => `${o.customer_name} ${o.customer_phone || ""}`, mobile: "subtitle",
      render: (o) => <span className="bz-two-line"><span>{o.customer_name}</span>{o.customer_phone && <small className="muted">{o.customer_phone}</small>}</span> },
    { key: "description", header: "To make", value: (o) => o.description },
    { key: "purity", header: "Purity", value: (o) => purityMark(o.metal, o.purity) },
    { key: "promised", header: "Promised", value: (o) => o.promised_on || "",
      render: (o) => (o.promised_on ? <span className={o.late ? "bz-due" : ""}>{dateShort(o.promised_on)}{o.late ? " · late" : ""}</span> : <span className="muted">—</span>) },
    { key: "status", header: "Status", type: "status", value: (o) => ORDER_STATUSES[o.status]?.label || o.status, mobile: "show",
      render: (o) => <Badge tone={ORDER_STATUSES[o.status]?.tone} label={ORDER_STATUSES[o.status]?.label || o.status} /> },
    money && { key: "advances", header: "Advances", type: "money", exact: true, value: (o) => Number(o.advances), total: "sum" },
    money && { key: "rate", header: "Rate fixed", value: (o) => Number(o.fixed_rate || 0), render: (o) => (o.fixed_rate ? perGram(biz, o.fixed_rate) : <span className="muted">Day's rate</span>) },
    { key: "location", header: "Location", value: (o) => o.location_name, defaultHidden: !many },
  ].filter(Boolean), [biz, money, many]);
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Custom orders"
        description="Pieces made to a customer's order: booked with an advance, made by a karigar, hallmarked, and delivered on the jewellery bill with the advances taken off."
        primary={biz.can("jewellery.create") && money && <button type="button" className="button" onClick={() => setBooking(true)}><Icon name="plus" size={16} /> Book an order</button>} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="clipboard" title="Orders" description={money ? RATE_RULE : undefined}>
        <div className="fe-chips" role="group" aria-label="Orders">
          {CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Order, customer, phone or design" }} caption="Custom orders" columns={columns}
          rowNoun={["order", "orders"]} onRowClick={(o) => setOpenId(o.id)} rowClassName={(o) => (o.late ? "dg-tone-danger" : ["delivered", "cancelled"].includes(o.status) ? "dg-tone-muted" : "")}
          empty="No orders here" emptyHint={biz.can("jewellery.create") ? "Book one with Book an order." : undefined} emptyIcon="clipboard" />
      </SectionCard>
      {booking && <OrderForm biz={biz} items={items} onClose={() => setBooking(false)} onSaved={(o) => { setBooking(false); list.reload(); setOpenId(o.id); }} />}
      {openId && <OrderPanel biz={biz} orderId={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </div>
  );
}
