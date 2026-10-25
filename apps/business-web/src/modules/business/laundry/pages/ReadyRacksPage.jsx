import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ITEM_STATUSES, quantityWords } from "./laundry";
import "../styles/laundry.css";

// Ready & racks: find a garment by its tag, the customer's phone or the order
// number (a scanner types the tag and presses Enter), see where it is, and put
// a finished one on a rack (rack and slot); below, every garment ready on the
// racks, rack by rack, with how long it has waited.

export default function ReadyRacksPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const input = useRef(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState({ q: "", items: [] });
  const [racks, setRacks] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useServerList("laundry/racks", { gridId: "laundry-racks" });
  const edit = biz.can("laundry.edit");
  useEffect(() => { input.current?.focus(); }, []);
  const typed = text.trim();
  // `asked`: Find was pressed, so an empty answer is said.
  const search = async (q, asked = false) => {
    setError("");
    try {
      const page = await businessRead(biz.id, "laundry/items", { q, limit: 12 });
      setFound({ q, items: page.items });
      if (asked && !page.items.length) setError("Nothing matches: check the tag, or search by phone or order number");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  // What is typed, searched after a short pause.
  useEffect(() => {
    if (typed.length < 1) return undefined;
    const timer = setTimeout(() => { search(typed); }, 300);
    return () => clearTimeout(timer);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (event) => {
    event.preventDefault();
    if (!typed) return;
    const exact = found.q === typed ? found.items.filter((i) => i.tag_no === typed.toUpperCase().replace(/\s+/g, "")) : [];
    // One garment in the shop with this exact tag: straight to its rack box.
    const inShop = exact.filter((i) => i.in_shop);
    if (inShop.length === 1 && edit) document.getElementById(`ldy-rack-${inShop[0].id}`)?.focus();
    else search(typed, true);
  };
  const putOnRack = async (item) => {
    setBusy(true);
    try {
      const rack = (racks[item.id] || "").trim();
      if (item.status === "ready") await businessWrite(biz.id, `laundry/orders/${item.order_id}/items/${item.id}`, { rack }, "patch");
      else await businessWrite(biz.id, `laundry/orders/${item.order_id}/status`, { status: "ready", itemIds: [item.id], ...(rack ? { rack } : {}) });
      toast.success(`${item.tag_no} ${item.status === "ready" ? "moved" : "is ready"}${rack ? ` on rack ${rack.toUpperCase()}` : ""}.`);
      setText("");
      setFound({ q: "", items: [] });
      list.reload();
      input.current?.focus();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const results = found.q === typed ? found.items : [];
  const columns = useMemo(() => [
    { key: "rack", header: "Rack", value: (i) => i.rack || "", className: "mono", mobile: "subtitle", render: (i) => i.rack || <span className="muted">No rack</span> },
    { key: "tag_no", header: "Tag", value: (i) => i.tag_no, className: "mono", mobile: "title", pin: true },
    { key: "garment", header: "Garment", value: (i) => `${i.garment_name} ${i.service_name}`,
      render: (i) => <span className="bz-two-line"><span>{i.garment_name} · {i.service_name}</span><small className="muted">{[quantityWords(i), i.colour].filter(Boolean).join(" · ")}</small></span> },
    { key: "order", header: "Order", value: (i) => `${i.order_no} ${i.customer_name} ${i.customer_phone || ""}`, mobile: "show",
      render: (i) => <Link to={biz.path(`garment-orders/${i.order_id}`)} className="bz-two-line"><span className="mono">{i.order_no}</span><small className="muted">{i.customer_name}{i.customer_phone ? ` · ${i.customer_phone}` : ""}</small></Link> },
    { key: "days_ready", header: "Ready for", type: "number", value: (i) => i.days_ready, render: (i) => (Number(i.days_ready) === 0 ? "Today" : `${i.days_ready} ${Number(i.days_ready) === 1 ? "day" : "days"}`) },
    { key: "promised_on", header: "Promised for", type: "date", value: (i) => i.promised_on, defaultHidden: true },
  ], [biz]);
  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Ready & racks" description="Find a garment by its tag, the customer's phone or the order number; put a finished one on a rack. Below: what hangs where." />
      <SectionCard icon="search" title="Find a garment">
        <form className="ldy-find" onSubmit={submit}>
          <input ref={input} className="ldy-find-input" value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
            placeholder="Tag, phone or order number" aria-label="Tag, phone or order number" autoComplete="off" spellCheck={false} />
          <button type="submit" className="button" disabled={busy || !typed}><Icon name="search" size={16} /> Find</button>
        </form>
        <ErrorMessage message={error} />
        {results.length > 0 && (
          <ul className="ldy-found">
            {results.map((i) => (
              <li key={i.id} className="ldy-found-row">
                <span className="ldy-found-tag mono">{i.tag_no}</span>
                <span className="bz-two-line"><span>{i.garment_name} · {i.service_name}</span><small className="muted">{[quantityWords(i), i.colour, i.brand].filter(Boolean).join(" · ")}</small></span>
                <Link to={biz.path(`garment-orders/${i.order_id}`)} className="bz-two-line"><span className="mono">{i.order_no}</span><small className="muted">{i.customer_name}{i.customer_phone ? ` · ${i.customer_phone}` : ""} · promised {dateShort(i.promised_on)}</small></Link>
                <span className="bz-two-line"><Badge tone={ITEM_STATUSES[i.status]?.tone} label={ITEM_STATUSES[i.status]?.label || i.status} /><small className="muted">{i.rack ? `rack ${i.rack}` : ""}</small></span>
                {edit && i.in_shop && (
                  <span className="ldy-found-rack">
                    <input id={`ldy-rack-${i.id}`} aria-label={`Rack for ${i.tag_no}`} className="mono" maxLength={20} placeholder={i.rack || "A-12"} value={racks[i.id] ?? ""}
                      onChange={(e) => setRacks((r) => ({ ...r, [i.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!(i.status === "ready" && !(racks[i.id] || "").trim())) putOnRack(i); } }} />
                    <button type="button" className="button button-sm" disabled={busy || (i.status === "ready" && !(racks[i.id] || "").trim())} onClick={() => putOnRack(i)}>{i.status === "ready" ? "Move" : "Ready"}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard flush icon="list" title="On the racks">
        <ErrorMessage message={list.error} />
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Rack, tag, customer or phone" }} caption="Garments ready on the racks" columns={columns}
          rowKey={(i) => i.id} rowNoun={["garment", "garments"]} onRowClick={(i) => navigate(biz.path(`garment-orders/${i.order_id}`))}
          empty="Nothing is ready on the racks" emptyHint="Garments show here once they are ready." emptyIcon="tag" />
      </SectionCard>
    </div>
  );
}
