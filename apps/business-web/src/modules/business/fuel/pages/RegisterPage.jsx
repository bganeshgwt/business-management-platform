import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { FlagBadge, OutletPicker } from "./FuelParts";
import { atWords, dayWords, densityText, firstOutlet, monthWords, qty, signed, variationText } from "./fuel";
import "../styles/fuel.css";

// The stock register and the density register of an outlet's tanks (the
// oil companies' Marketing Discipline Guidelines). The stock register runs
// from each morning's dip to the next: the opening dip, the loads received,
// less their shrinkage and temperature variation allowances (MDG 2024,
// Annexure 9), the meters' sales (closed shifts) with the test pumped back,
// the book stock, the next dip, and the variation against the tolerance: the
// operational variation of the dip stock either way, a loss also within the
// evaporation and handling allowance on what was sold. A manager posts a
// day's gap to the stock as a correction, saying why. The density register
// keeps each morning's density at 15 °C and each load's by invoice, at
// receipt and after decanting.

export default function RegisterPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [outlet, setOutlet] = useState(() => firstOutlet(biz));
  const [view, setView] = useState("stock");
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const path = view === "stock" ? "fuel/register" : "fuel/density";
    const query = { ...(outlet ? { locationId: outlet } : {}), ...(view === "stock" ? range : { month }) };
    const key = JSON.stringify([view, query]);
    businessRead(biz.id, path, query, controller.signal)
      .then((d) => { setData({ key, view, ...d }); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, outlet, view, range, month, version]);

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={view === "stock" ? "Stock register" : "Density register"}
        description={view === "stock"
          ? "Each tank day by day, from one morning's dip to the next: the book stock against the dip, and the variation against the tolerance."
          : "Each tank's density at 15 °C: the morning's sample, and each load's by invoice, at receipt and after decanting."} />
      <div className="fuel-toolbar">
        <OutletPicker biz={biz} value={outlet} onChange={setOutlet} />
        <Segmented label="Register" options={[{ value: "stock", label: "Stock register" }, { value: "density", label: "Density register" }]} value={view} onChange={setView} />
        {view === "stock"
          ? <DateRangeFilter from={range.from} to={range.to} anchor={today} label="dates" onChange={(next) => next.from && next.to && setRange(next)} />
          : <label className="field fuel-outlet"><span>Month</span><input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>}
      </div>
      <ErrorMessage message={error} />
      {!data || data.key !== JSON.stringify([view, { ...(outlet ? { locationId: outlet } : {}), ...(view === "stock" ? range : { month }) }]) ? (!error && <Loading />)
        : !data.tanks.length ? <p className="muted">No tanks at this outlet: add them under Settings › Pumps & nozzles.</p>
          : view === "stock" ? data.tanks.map((t) => <StockTank key={t.id} biz={biz} tank={t} data={data} onPosted={() => setVersion((n) => n + 1)} />)
            : data.tanks.map((t) => <DensityTank key={t.id} biz={biz} tank={t} month={data.month} />)}
    </div>
  );
}

function StockTank({ biz, tank, data, onPosted }) {
  const unit = tank.unit;
  const [posting, setPosting] = useState(null);
  const canPost = biz.can("fuel.approve") && biz.can("inventory.edit");
  const flagged = tank.rows.filter((r) => ["loss", "gain"].includes(r.flag)).length;
  return (
    <SectionCard flush icon="layers" title={`Tank ${tank.tank_no} · ${tank.product_name}`}
      description={`Allowed: ${Number(data.settings.variationPercent).toFixed(2)}% of the dip either way; a loss also ${tank.allowance}% of what was sold, for evaporation and handling.${flagged ? ` ${flagged} ${flagged === 1 ? "day" : "days"} beyond it.` : ""}`}>
      <DataGrid variant="compact" id={`fuel-register-${tank.id}`} caption={`Stock register of tank ${tank.tank_no}`} rows={tank.rows} rowKey={(r) => r.day} rowNoun={["day", "days"]}
        rowClassName={(r) => (r.flag === "gain" ? "dg-tone-danger" : r.flag === "loss" ? "dg-tone-warning" : "")}
        exportName={biz.can("fuel.export") ? `${biz.business.code}-stock-register-${tank.tank_no}` : undefined}
        columns={[
          { key: "day", header: "Day", value: (r) => r.day, mobile: "title", pin: true, render: (r) => <span className="bz-two-line"><strong>{dayWords(r.day)}</strong><small className="muted">dip {atWords(r.takenAt, biz)}</small></span> },
          { key: "opening", header: "Opening dip", value: (r) => Number(r.opening), className: "mono", render: (r) => qty(r.opening, unit) },
          { key: "receipts", header: "Received", value: (r) => Number(r.receipts), className: "mono", render: (r) => <span title={r.loads.join(", ")}>{qty(r.receipts, unit)}</span> },
          { key: "allowances", header: "Shrinkage and TVA", value: (r) => Number(r.shrinkage) + Number(r.tva), className: "mono",
            render: (r) => (Number(r.shrinkage) || Number(r.tva) ? `${qty(r.shrinkage, unit)} · ${qty(r.tva, unit)}` : "—") },
          { key: "meter", header: "Meters", value: (r) => Number(r.meter), className: "mono", render: (r) => qty(r.meter, unit), defaultHidden: true },
          { key: "test", header: "Test pumped back", value: (r) => Number(r.test), className: "mono", render: (r) => qty(r.test, unit), defaultHidden: true },
          { key: "sales", header: "Sold", value: (r) => Number(r.sales), className: "mono", render: (r) => qty(r.sales, unit) },
          { key: "book", header: "Book stock", value: (r) => Number(r.book), className: "mono", render: (r) => qty(r.book, unit) },
          { key: "closing", header: "Next dip", value: (r) => (r.closing === null ? "" : Number(r.closing)), className: "mono",
            render: (r) => (r.closing === null ? <span className="muted">{r.openShifts ? `${r.openShifts} open ${r.openShifts === 1 ? "shift" : "shifts"}` : "—"}</span> : qty(r.closing, unit)) },
          { key: "variation", header: "Variation", value: (r) => (r.variation === null ? "" : Number(r.variation)), className: "mono", mobile: "subtitle", render: (r) => variationText(r, unit) },
          { key: "allowed", header: "Allowed", value: (r) => (r.allowedLoss === null ? "" : Number(r.allowedLoss)), className: "mono",
            render: (r) => (r.allowedLoss === null ? "—" : `+${Number(r.allowedGain).toFixed(3)} / −${Number(r.allowedLoss).toFixed(3)}`) },
          { key: "flag", header: "Tolerance", value: (r) => r.flag, mobile: "show", render: (r) => <FlagBadge flag={r.flag} /> },
          { key: "posted", header: "To the stock", value: (r) => (r.correction ? Number(r.correction.litres) : ""), mobile: "show",
            render: (r) => (r.correction ? <Badge tone="neutral" label={`Posted ${signed(r.correction.litres, 3)}`} />
              : r.gap !== null && Number(r.gap) !== 0 && canPost && !r.openShifts ? <button type="button" className="chip-button" onClick={() => setPosting(r)}>Post {signed(r.gap, 3)}</button> : "—") },
          { key: "water", header: "Water", value: (r) => (r.waterCm === null ? "" : Number(r.waterCm)), render: (r) => (r.waterCm === null ? "—" : `${Number(r.waterCm)} cm`), defaultHidden: true },
        ]}
        empty="No dips in these dates" emptyHint="Each morning's dip starts a day of the register (Tanks & dips)." emptyIcon="clipboard" />
      {posting && (
        <ReasonDialog title={`Post tank ${tank.tank_no}'s ${dayWords(posting.day)} to the stock`} icon="layers" label="Why the stock is corrected" submitLabel="Post it"
          description={`The stock of ${tank.product_name} moves by ${signed(posting.gap, 3)} ${unit === "kg" ? "kg" : "litres"}: the dip against the stock by the meters and the invoices. Once only.`}
          onClose={() => setPosting(null)} onSaved={() => { setPosting(null); toast.success("Posted to the stock."); onPosted(); }}
          onSubmit={(reason) => businessWrite(biz.id, "fuel/register/corrections", { requestKey: newKey(), tankId: tank.id, day: posting.day, reason })} />
      )}
    </SectionCard>
  );
}

function DensityTank({ biz, tank, month }) {
  return (
    <SectionCard flush icon="layers" title={`Tank ${tank.tank_no} · ${tank.product_name}`} description={monthWords(month)}>
      <DataGrid variant="compact" id={`fuel-density-${tank.id}`} caption={`Density register of tank ${tank.tank_no}`} rows={tank.rows} rowKey={(r) => r.day} rowNoun={["day", "days"]}
        exportName={biz.can("fuel.export") ? `${biz.business.code}-density-register-${tank.tank_no}` : undefined}
        rowClassName={(r) => (r.loads.some((l) => !l.within) ? "dg-tone-warning" : "")}
        columns={[
          { key: "day", header: "Day", value: (r) => r.day, mobile: "title", pin: true, render: (r) => dayWords(r.day) },
          { key: "morning", header: "Morning density", value: (r) => (r.dip?.density ? Number(r.dip.density) : ""), className: "mono",
            render: (r) => (r.dip?.density ? `${densityText(r.dip.density)}${r.dip.temperature !== null ? ` · ${Number(r.dip.temperature)} °C` : ""}` : "—") },
          { key: "loads", header: "Loads", value: (r) => r.loads.map((l) => l.invoice_no).join(", "), mobile: "subtitle",
            render: (r) => (r.loads.length ? (
              <ul className="fuel-plain">
                {r.loads.map((l) => (
                  <li key={l.invoice_no + l.received_at}>
                    <span className="mono">{l.invoice_no}</span> · invoice {densityText(l.invoice_density)}, received {densityText(l.receipt_density)}{" "}
                    <Badge tone={l.within ? "success" : "danger"} label={`${signed(l.difference)} ${l.within ? "within" : "outside"}`} />
                    {l.decant_density !== null && <> · after decanting {densityText(l.decant_density)}</>}
                    {l.status !== "accepted" && <> · {l.status}</>}
                  </li>
                ))}
              </ul>
            ) : "—") },
        ]}
        empty="Nothing this month" emptyHint="The morning dips and the tanker loads write this register." emptyIcon="layers" />
    </SectionCard>
  );
}
