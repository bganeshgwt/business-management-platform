import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { OLD_GOLD_STATES, grams, marksOf } from "./jewellery";
import { CASH_RULE, OldGoldForm, OldGoldPanel } from "./OldGoldDialogs";
import "../styles/jewellery.css";

// Old gold: the gold, silver and platinum customers sell to the shop or give
// in exchange, each on a voucher with its articles tested, weighed and valued
// at today's buy rate. A voucher's value is paid out (UPI or bank transfer
// first; cash is limited), used on the seller's jewellery bill, or both; its
// metal is the shop's own for melting and refining. Money shows to those who
// see sales; the server checks every step.

const CHIPS = [["open", "Value left", { state: "open" }], ["settled", "Settled", { state: "settled" }], ["cancelled", "Cancelled", { state: "cancelled" }], ["all", "All", {}]];

export default function OldGoldPage() {
  const biz = useOpenBusiness();
  const [chip, setChip] = useState("open");
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [taking, setTaking] = useState(false);
  const [openId, setOpenId] = useState(null);
  const params = useMemo(() => CHIPS.find(([value]) => value === chip)?.[2] || {}, [chip]);
  const list = useServerList("jewellery/old-gold", { gridId: "jewellery-old-gold", params });
  const many = biz.locations.length > 1;
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/settings", undefined, controller.signal).then((s) => { setSettings(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const columns = useMemo(() => [
    { key: "voucher_no", header: "Voucher", value: (g) => g.voucher_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Taken in", type: "datetime", value: (g) => g.created_at },
    { key: "seller", header: "Seller", value: (g) => `${g.seller_name} ${g.seller_phone || ""}`, mobile: "subtitle",
      render: (g) => <span className="bz-two-line"><span>{g.seller_name}</span>{g.seller_phone && <small className="muted">{g.seller_phone}</small>}</span> },
    { key: "purities", header: "Purity", value: (g) => marksOf(g.purities) },
    { key: "net_weight", header: "Net", value: (g) => Number(g.net_weight), render: (g) => grams(g.net_weight), total: "sum" },
    { key: "fine_weight", header: "Fine", value: (g) => Number(g.fine_weight), render: (g) => grams(g.fine_weight), total: "sum" },
    { key: "value", header: "Value", type: "money", exact: true, value: (g) => Number(g.value), total: "sum", mobile: "show" },
    { key: "used", header: "Used on bills", type: "money", exact: true, value: (g) => Number(g.used), defaultHidden: true },
    { key: "paid", header: "Paid out", type: "money", exact: true, value: (g) => Number(g.paid), defaultHidden: true },
    { key: "balance", header: "Left", type: "money", exact: true, value: (g) => Number(g.balance), total: "sum" },
    { key: "state", header: "State", type: "status", value: (g) => OLD_GOLD_STATES[g.state]?.label || g.state, mobile: "show",
      render: (g) => <Badge tone={OLD_GOLD_STATES[g.state]?.tone} label={OLD_GOLD_STATES[g.state]?.label || g.state} /> },
    { key: "location", header: "Location", value: (g) => g.location_name || "", defaultHidden: !many },
    { key: "by", header: "Taken in by", value: (g) => g.by_name, defaultHidden: true },
  ], [many]);
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title="Old gold"
        description="Gold, silver and platinum customers sell to the shop or give in exchange: tested, weighed and valued at today's buy rate, then paid out or used on their jewellery bill."
        primary={biz.can("jewellery.create") && <button type="button" className="button" disabled={!settings} onClick={() => setTaking(true)}><Icon name="plus" size={16} /> Take in old gold</button>} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="scale" title="Vouchers" description={CASH_RULE}>
        <div className="fe-chips" role="group" aria-label="Vouchers">
          {CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Voucher, seller or phone" }} caption="Old gold vouchers" columns={columns}
          rowNoun={["voucher", "vouchers"]} onRowClick={(g) => setOpenId(g.id)} rowClassName={(g) => (g.state === "cancelled" ? "dg-tone-muted" : "")}
          empty="No old gold here" emptyHint={biz.can("jewellery.create") ? "Take some in with Take in old gold." : undefined} emptyIcon="scale" />
      </SectionCard>
      {taking && <OldGoldForm biz={biz} settings={settings} onClose={() => setTaking(false)} onSaved={(g) => { setTaking(false); list.reload(); setOpenId(g.id); }} />}
      {openId && <OldGoldPanel biz={biz} voucherId={openId} settings={settings} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </div>
  );
}
