import SectionCard from "../../../../components/SectionCard";
import { Field } from "../../core/pages/ui";
import { businessToday } from "../../core/pages/hooks";
import { SEASONS, barredWords, listWords, matchCrop } from "./agri";
import "../styles/agri.css";

// The counter's farm-input card, for a seeds, fertilisers & pesticides shop:
// the PoS receipt number of a subsidised fertiliser, the crop a
// crop-restricted pesticide is bought for, a walk-in farmer's name and
// village (for the insecticide register), and, on udhaar, the season the
// credit is for and the harvest date it falls due. It says ahead what the
// server will refuse; the server checks it all again. `notes`: the server's
// licence checks of the lines (useLicenceNotes in agri.js), a stop the bill
// will be refused for or a warning it is billed with.

export default function AgriBillFields({ biz, needs, value, onChange, master, customer, credit, notes }) {
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.value });
  const today = businessToday(biz.business.timezone);
  const year = Number(today.slice(0, 4));
  const crop = matchCrop(master, value.crop);
  const pair = crop && needs.barred.find((m) => m.crops.some((c) => c.code === crop.code));
  const walkIn = !customer && needs.any;
  const seasonCredit = credit && customer;
  if (!needs.any && !seasonCredit) return null;
  return (
    <SectionCard icon="leaf" title="Farm inputs">
      {(notes || []).map((n, i) => (n.level === "stop"
        ? <p key={`${n.skuId}-${i}`} className="agri-stop" role="alert">{n.message}</p>
        : <p key={`${n.skuId}-${i}`} className="agri-warn">{n.message}</p>))}
      {needs.banned.map((b) => <p key={b.label} className="agri-stop">{b.label} contains {b.molecule.name}, banned in India ({b.molecule.source}): it cannot be sold.</p>)}
      {needs.subsidised.length > 0 && (
        <Field label="PoS receipt number" hint={`For ${listWords(needs.subsidised)}: the receipt the PoS device printed after the farmer's thumb check. Never the Aadhaar number.`}>
          <input required maxLength={40} className="mono" value={value.posReceipt} onChange={set("posReceipt")} />
        </Field>
      )}
      {needs.any && (
        <Field label={needs.barred.length ? "Crop it is for" : "Crop it is for (optional)"}>
          <input required={needs.barred.length > 0} maxLength={100} list="agri-counter-crops" value={value.crop} onChange={set("crop")} placeholder="e.g. Paddy" />
        </Field>
      )}
      <datalist id="agri-counter-crops">{(master?.crops || []).map((c) => <option key={c.code} value={c.name} />)}</datalist>
      {needs.barred.map((m) => <p key={m.code} className="agri-note">{barredWords(m)}</p>)}
      {needs.restricted.map((m) => <p key={m.code} className="agri-note">{m.name}: {m.restriction}</p>)}
      {pair && <p className="agri-stop" role="alert">{pair.name} must not be used on {crop.name.toLowerCase()}: it cannot be sold for that crop.</p>}
      {walkIn && (
        <div className="rt-inline">
          <Field label="Farmer's name (optional)"><input maxLength={150} value={value.farmerName} onChange={set("farmerName")} /></Field>
          <Field label="Village (optional)"><input maxLength={100} value={value.village} onChange={set("village")} /></Field>
        </div>
      )}
      {seasonCredit && (
        <div className="rt-inline">
          <Field label="Season credit (optional)">
            <select value={value.season} onChange={(e) => onChange({ ...value, season: e.target.value, seasonYear: value.seasonYear || String(year) })}>
              <option value="">No season</option>
              {SEASONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          {value.season && (
            <>
              <Field label="Year">
                <select value={value.seasonYear || String(year)} onChange={set("seasonYear")}>
                  {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </Field>
              <Field label="Due at the harvest on"><input type="date" required min={today} value={value.dueOn} onChange={set("dueOn")} /></Field>
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
