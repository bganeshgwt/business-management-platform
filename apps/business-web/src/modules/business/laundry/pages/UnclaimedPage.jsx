import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { LIEN_NOTE, messageLink } from "./laundry";
import "../styles/laundry.css";

// Unclaimed: orders ready and not collected for the shop's days (30 until
// changed, Services & items › Price list), the longest waiting first, with a reminder
// ready on WhatsApp (or a call) and every reminder kept with how many were
// sent. The garments stay held until paid; nothing here disposes of them.

export default function UnclaimedPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const list = useServerList("laundry/unclaimed", { gridId: "laundry-unclaimed" });
  const money = biz.can("sales.view");
  const remind = (o, channel) => {
    if (channel === "whatsapp" && o.customer_phone) window.open(messageLink(biz, { ...o, due: o.balance }, "reminder"), "_blank", "noopener");
    businessWrite(biz.id, `laundry/orders/${o.id}/notices`, { kind: "reminder", channel })
      .then((r) => { toast.success(`Reminder to ${o.customer_name} noted (${r.reminders} in all).`); list.reload(); })
      .catch((err) => toast.error(getErrorMessage(err)));
  };
  const days = list.data?.items?.[0]?.unclaimed_days;
  const columns = useMemo(() => [
    { key: "order_no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "title", pin: true },
    { key: "customer", header: "Customer", value: (o) => `${o.customer_name} ${o.customer_phone || ""}`, mobile: "show",
      render: (o) => <span className="bz-two-line"><span>{o.customer_name}</span>{o.customer_phone && <small className="muted">{o.customer_phone}</small>}</span> },
    { key: "waiting", header: "Waiting", type: "number", value: (o) => o.days_ready, mobile: "subtitle",
      render: (o) => <span className="bz-two-line"><span className="bz-minus">{o.days_ready} days</span><small className="muted">ready since {dateShort(o.ready_since, { year: true })}</small></span> },
    { key: "pieces", header: "Garments waiting", value: (o) => o.ready_pieces,
      render: (o) => <span className="bz-two-line"><span>{o.ready_items} {o.ready_items === 1 ? "garment" : "garments"} · {o.ready_pieces} {o.ready_pieces === 1 ? "piece" : "pieces"}</span><small className="muted mono">{o.racks || "no rack"}</small></span> },
    money && { key: "balance", header: "To pay", type: "money", exact: true, value: (o) => (o.balance === null ? null : Number(o.balance)), total: "sum" },
    { key: "reminders", header: "Reminders sent", type: "number", value: (o) => o.reminders,
      render: (o) => (o.reminders ? <span className="bz-two-line"><span>{o.reminders}</span><small className="muted">last {dateShort(o.last_notice_at)}</small></span> : <span className="muted">None</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (
      <span className="bz-row-actions">
        {o.customer_phone && <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); remind(o, "whatsapp"); }}><Icon name="message" size={14} /> WhatsApp</button>}
        {o.customer_phone && <a className="chip-button" href={`tel:${o.customer_phone.replace(/[^\d+]/g, "")}`} onClick={(e) => { e.stopPropagation(); remind(o, "call"); }}><Icon name="phone" size={14} /> Call</a>}
      </span>
    ) },
  ].filter(Boolean), [biz, money]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <BusinessHeader icon="clock" title="Unclaimed"
        description={`Orders ready and not collected for ${days || "the shop's"} days or more, the longest waiting first. Each reminder sent is kept; nothing here disposes of a garment.`} />
      <p className="ldy-note">{LIEN_NOTE} No Indian rule was found that lets a shop dispose of garments not collected.</p>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="clock" title="Not collected" actions={<Link className="button button-secondary button-sm" to={biz.path("laundry-prices")}>Change the days</Link>}>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Order, customer, phone or tag" }} caption="Unclaimed orders" columns={columns} currency={biz.symbol}
          rowNoun={["order", "orders"]} onRowClick={(o) => navigate(biz.path(`garment-orders/${o.id}`))}
          rowClassName={(o) => (o.reminders ? "" : "dg-tone-warning")}
          empty="No order is waiting that long" emptyHint="Orders show here once they have been ready for the shop's days and not collected." emptyIcon="clock" />
      </SectionCard>
    </div>
  );
}
