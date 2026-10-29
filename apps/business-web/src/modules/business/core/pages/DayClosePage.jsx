import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { businessPath, GOODS } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import { dateLong } from "@bmp/shared/format";
import { BusinessHeader, Field } from "./ui";
import { businessToday, useOpenBusiness } from "./hooks";
import CashCheck from "./CashCheck";
import CashierShifts from "./CashierShifts";
import { KIND_WORDS } from "./paymentMethods";
// A jeweller's old gold with value left, paid out seller by seller.
import { OldGoldToPay } from "../../jewellery/pages/OldGoldPayouts";

// Day close: what the counter sold and the money that came
// in and went out today (or over a few days), by payment method, by the
// person who took it and by counter, with net cash movement and an optional counted drawer snapshot.
// The printable end-of-day slip is 72 mm wide.

const METHODS = Object.entries(KIND_WORDS);

// The business's own method names within each kind (PhonePe and Paytm under
// UPI), from the day close's byMethodName: one row per name.
function namedRows(data) {
  const named = data?.byMethodName;
  if (!named) return [];
  const rows = new Map();
  for (const [group, list] of Object.entries(named)) {
    for (const r of list) {
      const id = `${r.method}|${r.name}`;
      if (!rows.has(id)) rows.set(id, { id, name: r.name, kind: KIND_WORDS[r.method] || r.method, received: 0, refunds: 0, suppliers: 0, bounced: 0, expenses: 0 });
      rows.get(id)[group] += Number(r.amount);
    }
  }
  return [...rows.values()].map((r) => ({ ...r, net: r.received - r.refunds - r.suppliers - r.bounced - r.expenses }));
}
// Worth a table of its own only when a name says more than the kind does.
const namesSayMore = (rows) => rows.some((r) => r.name !== r.kind);

export default function DayClosePage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: anchor, to: anchor });
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || (biz.locations.length === 1 ? biz.locations[0].id : "")));
  const [response, setResponse] = useState({key:"",data:null,error:""});
  const [version,setVersion] = useState(0);
  // A reload after a cash check keeps today's figures on screen until the new ones arrive.
  const scope = `${biz.id}:${range.from}:${range.to}:${locationId}`;
  const currentKey = `${scope}:${version}`;
  const {data,error} = response.key === currentKey ? response
    : response.scope === scope && response.data ? {data:response.data,error:""} : {data:null,error:""};
  const locations = biz.locations;

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "reports/takings", { ...range, ...(locationId ? { locationId } : {}) }, controller.signal)
      .then((d) => { if (!controller.signal.aborted) setResponse({key:currentKey,scope,data:d,error:""}); })
      .catch((err) => { if (!controller.signal.aborted) setResponse({key:currentKey,scope,data:null,error:getErrorMessage(err)}); });
    return () => controller.abort();
  }, [biz.id, range, locationId, currentKey, scope]);

  const methodRows = data ? METHODS.map(([code, name]) => ({
    id: code, name, received: Number(data.received[code]), refunds: Number(data.refunds[code]), suppliers: Number(data.suppliers[code]), bounced: Number(data.bounced?.[code] || 0), expenses: Number(data.expenses?.[code] || 0),
    net: Number(data.received[code]) - Number(data.refunds[code]) - Number(data.suppliers[code]) - Number(data.bounced?.[code] || 0) - Number(data.expenses?.[code] || 0),
  })).filter((r) => r.received || r.refunds || r.suppliers || r.bounced || r.expenses) : [];
  const anyBounced = Number(data?.bounced?.total || 0) > 0;
  const byName = namedRows(data);
  const methodColumns = [
    { key: "name", header: "Method", value: (r) => r.name, mobile: "title" },
    { key: "received", header: "Came in", type: "money", exact: true, value: (r) => r.received, total: "sum", mobile: "show" },
    { key: "refunds", header: "Refunded", type: "money", exact: true, value: (r) => r.refunds, total: "sum" },
    { key: "suppliers", header: "Paid to suppliers", type: "money", exact: true, value: (r) => r.suppliers, total: "sum" },
    ...(data?.expenses?.visible ? [{ key: "expenses", header: "Expenses", type: "money", exact: true, value: (r) => r.expenses, total: "sum" }] : []),
    ...(anyBounced ? [{ key: "bounced", header: "Cheques bounced", type: "money", exact: true, value: (r) => r.bounced, total: "sum" }] : []),
    { key: "net", header: "Net", type: "money", exact: true, value: (r) => r.net, total: "sum", mobile: "show" },
  ];
  const personColumns = [
    { key: "name", header: "Who", value: (r) => r.name, mobile: "title" },
    { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, total: "sum", mobile: "show" },
    { key: "sales", header: "Sales", type: "money", exact: true, value: (r) => Number(r.sales), total: "sum" },
    ...METHODS.slice(0, 3).map(([code, name]) => ({ key: code, header: name, type: "money", exact: true, value: (r) => Number(r.in[code]), total: "sum" })),
    { key: "received", header: "Took in all", type: "money", exact: true, value: (r) => Number(r.received), total: "sum", mobile: "show" },
    { key: "out", header: "Paid out", type: "money", exact: true, value: (r) => Number(r.out), total: "sum", defaultHidden: true },
  ];
  const oneDay = range.from === range.to;

  return (
    <div className="stack">
      <BusinessHeader icon="clock" title="Daily money"
        description="Sales, collections, refunds, supplier payments and daily expenses. Check cash for a single day and location."
        primary={data && biz.can("sales.print") && <button type="button" className="button" onClick={() => printSlip(data, biz, locations)}><Icon name="print" size={16} /> Print end-of-day slip</button>}
        secondary={biz.can("sales.create") && GOODS.includes(biz.type) &&<Link className="button button-secondary" to={businessPath(biz.id, "counter")}><Icon name="receipt" size={15} /> Quick bill</Link>} />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title={oneDay ? dateLong(range.from) : `${dateLong(range.from)} to ${dateLong(range.to)}`}
        actions={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="day close dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />}>
        {locations.length > 1 && (
          <Field label="Counter / location">
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        )}
        <div className="stat-grid bz-stat-grid">
          <StatTile icon="receipt" tone="primary" label="Sales" value={data ? biz.exact(data.sales.total) : undefined} loading={!data} note={data ? `${data.sales.bills} bills${Number(data.sales.returns) ? ` · returns ${biz.exact(data.sales.returns)}` : ""}` : undefined} />
          <StatTile icon="cash" tone="success" label="Net cash movement" value={data ? biz.exact(data.cashInHand) : undefined} loading={!data} note={data?.expenses?.visible ? "cash in, less refunds, supplier payments and expenses" : "includes expenses paid; your role does not show their amounts"} />
          <StatTile icon="wallet" label="Money in" value={data ? biz.exact(data.received.total) : undefined} loading={!data} note={data ? `udhaar collected ${biz.exact(data.received.collections)}` : undefined} />
          <StatTile icon="clipboard" tone={data && Number(data.sales.onCredit) > 0 ? "warning" : "neutral"} label="Given on udhaar" value={data ? biz.exact(data.sales.onCredit) : undefined} loading={!data}
            note={data && Number(data.sales.walkInUnpaid) > 0 ? `walk-in bills unpaid ${biz.exact(data.sales.walkInUnpaid)}` : "on named customers' bills"} />
        </div>
      </SectionCard>
      <CashCheck biz={biz} data={data} date={oneDay ? range.from : null} locationId={locationId} onSaved={()=>setVersion(v=>v+1)} />
      <CashierShifts biz={biz} date={oneDay ? range.from : null} locationId={locationId} version={version} />
      <OldGoldToPay biz={biz} onPaid={() => setVersion((v) => v + 1)} />
      <SectionCard flush icon="wallet" title="By payment method">
        <DataGrid id="business-day-close-methods" caption="Takings by payment method" rows={methodRows} columns={methodColumns} currency={biz.symbol} loading={!data && !error}
          rowNoun={["method", "methods"]} empty="No money moved in these dates" emptyIcon="wallet" />
      </SectionCard>
      {namesSayMore(byName) && (
        <SectionCard flush icon="list" title="By method name" description="Each kind split by the names your counter uses (Settings › Payment methods).">
          <DataGrid id="business-day-close-method-names" caption="Takings by method name" rows={byName} currency={biz.symbol}
            columns={[methodColumns[0], { key: "kind", header: "Kind", value: (r) => r.kind, mobile: "subtitle" }, ...methodColumns.slice(1)]}
            rowNoun={["method", "methods"]} empty="No money moved in these dates" emptyIcon="wallet" />
        </SectionCard>
      )}
      <SectionCard flush icon="users" title="By person">
        <DataGrid id="business-day-close-people" caption="Takings by person" rows={(data?.byPerson || []).map((p) => ({ ...p, id: p.userId }))} columns={personColumns}
          currency={biz.symbol} loading={!data && !error} rowNoun={["person", "people"]} empty="Nobody billed or took money in these dates" emptyIcon="users" />
      </SectionCard>
      {(data?.byLocation || []).length > 1 && (
        <SectionCard flush icon="store" title="By counter / location">
          <DataGrid id="business-day-close-locations" caption="Takings by location" rows={data.byLocation.map((p) => ({ ...p, id: p.locationId }))} currency={biz.symbol}
            columns={[{ key: "name", header: "Location", value: (r) => r.name, mobile: "title" }, ...personColumns.slice(1)]} rowNoun={["location", "locations"]} />
        </SectionCard>
      )}
      {data && (
        <SectionCard icon="info" title="What went into these figures">
          <ul className="bz-notes">
            <li>Paid at the counter {biz.exact(data.received.atSale)} · paid later on bills {biz.exact(data.received.laterOnBills)} · udhaar and advances collected {biz.exact(data.received.collections)}.</li>
            <li>Offers {biz.exact(data.sales.offers)} · points {biz.exact(data.sales.points)} · counter discounts {biz.exact(data.sales.counterDiscounts)} · round-off {biz.exact(data.sales.roundOff)} · GST {biz.exact(data.sales.tax)}.</li>
            <li>Refunds {biz.exact(data.refunds.total)} (bills returned and advances handed back) · paid to suppliers {biz.exact(data.suppliers.total)}{anyBounced ? ` · cheques bounced ${biz.exact(data.bounced.total)} (taken off on the day they bounced)` : ""}.</li>
            {Number(data.received.fromSuppliers || 0) > 0 && <li>Supplier refunds received {biz.exact(data.received.fromSuppliers)} are included in money in.</li>}
            <li>A bill paid several ways (cash + UPI + card) counts each part under its own method; only the cash part is in the drawer, and change is given from cash.</li>
            {data.finance && (Number(data.finance.booked) > 0 || Number(data.received.fromFinanciers) > 0 || Number(data.finance.cancelled) > 0) && (
              <li>EMI: {biz.exact(data.finance.booked)} financed on {data.finance.bills} {data.finance.bills === 1 ? "bill" : "bills"} (owed by financiers, not in the drawer){Number(data.finance.cancelled) > 0 ? ` · loans cancelled ${biz.exact(data.finance.cancelled)}` : ""} · payouts received {biz.exact(data.received.fromFinanciers)}{Number(data.finance.subvention) > 0 ? ` after ${biz.exact(data.finance.subvention)} subvention` : ""}.</li>
            )}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

// The end-of-day (Z) slip, 72 mm.
function printSlip(data, biz, locations) {
  const seller = data.seller || {};
  const m = (v) => escapeHtml(biz.exact(v));
  const row = (label, value) => `<div class="row"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
  const place = data.locationId ? locations.find((l) => String(l.id) === String(data.locationId))?.name : "All locations";
  printDocument({
    title: `Day close ${data.from}`,
    styles: `body{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#000;width:72mm} @page{size:80mm auto;margin:3mm}
      h1{font-size:14px;text-align:center;margin:0} .c{text-align:center} .row{display:flex;justify-content:space-between;gap:8px}
      hr{border:0;border-top:1px dashed #000;margin:6px 0} .big{font-size:14px;font-weight:700}`,
    body: `<h1>${escapeHtml(seller.display_name || biz.business.name)}</h1><div class="c">END OF DAY · ${escapeHtml(data.from === data.to ? data.from : `${data.from} to ${data.to}`)}</div>
      <div class="c">${escapeHtml(place || "")}</div><hr>
      ${row("Bills", escapeHtml(String(data.sales.bills)))}${row("Sales", m(data.sales.total))}${row("Returns", m(data.sales.returns))}${row("Net sales", m(data.sales.net))}
      ${row("GST in sales", m(data.sales.tax))}${row("Discounts at counter", m(data.sales.counterDiscounts))}<hr>
      ${(data.byMethodName ? data.byMethodName.received.map((r) => [r.name, r.amount]) : METHODS.filter(([c]) => Number(data.received[c])).map(([c, n]) => [n, data.received[c]]))
        .map(([n, v]) => row(`${n} in`, m(v))).join("")}
      ${row("Money in", m(data.received.total))}${row("Refunds", m(data.refunds.total))}${row("Paid to suppliers", m(data.suppliers.total))}${data.expenses?.visible ? row("Expenses (net)", m(data.expenses.total)) : ""}${Number(data.bounced?.total || 0) ? row("Cheques bounced", m(data.bounced.total)) : ""}<hr>
      <div class="row big"><span>NET CASH MOVEMENT</span><span>${m(data.cashInHand)}</span></div>
      ${row("Given on udhaar", m(data.sales.onCredit))}${row("Udhaar collected", m(data.received.collections))}
      ${data.finance && Number(data.finance.booked) ? row("Financed on EMI", m(data.finance.booked)) : ""}${Number(data.received.fromFinanciers || 0) ? row("From financiers", m(data.received.fromFinanciers)) : ""}<hr>
      ${data.byPerson.map((p) => row(`${p.name} (${p.bills})`, m(p.received))).join("")}<hr>
      <div class="c">Counted cash: ______________</div><div class="c">Signature: ______________</div>
      <div class="c" style="margin-top:6px">Printed ${escapeHtml(new Date().toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</div>`,
  });
}
