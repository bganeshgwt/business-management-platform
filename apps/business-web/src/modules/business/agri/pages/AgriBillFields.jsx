import { useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import { dateShort } from "@bmp/shared/format";
import { Field } from "../../core/pages/ui";
import { businessToday } from "../../core/pages/hooks";
import AgriOverrideDialog from "./AgriOverrideDialog";
import { SEASONS, barredPair, barredWords, listWords, matchCrop, pairWords, seasonWord, useOpenSeasons } from "./agri";
import "../styles/agri.css";

// The counter's farm-input card, for a seeds, fertilisers & pesticides shop:
// the PoS receipt number of a subsidised fertiliser, the crop a pesticide is
// bought for, a walk-in farmer's name and village (for the registers; sulphur
// needs both), and, on udhaar, the farmer's season credit (one of theirs, or a
// new season and the harvest date it falls due). It says ahead what the server
// will refuse or warn of (`checks`, useCounterChecks in agri.js: the licences,
// a restricted-use pesticide for a buyer not tagged, a crop off a pesticide's
// label, the farmer's subsidised bags this month) and asks a manager's
// override where the shop allows one. The server checks it all again.

const HELD = { restricted_use: "restricted-use pesticide", bag_limit: "bags over the limit" };

export default function AgriBillFields({ biz, needs, value, onChange, master, customer, credit, checks, locationId }) {
  const [asking, setAsking] = useState(null);
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.value });
  const today = businessToday(biz.business.timezone);
  const year = Number(today.slice(0, 4));
  const crop = matchCrop(master, value.crop);
  const pair = barredPair(needs.barred, crop);
  const walkIn = !customer && needs.any;
  const seasonCredit = credit && customer;
  const seasons = useOpenSeasons(biz, seasonCredit ? customer.id : null);
  const notes = checks?.notes || [];
  if (!needs.any && !seasonCredit) return null;
  const overrides = value.overrides || {};
  const given = (override) => {
    onChange({ ...value, overrides: { ...overrides, [override.kind]: override } });
    setAsking(null);
  };
  const note = (n, i) => {
    const allowed = n.override && overrides[n.override];
    if (allowed) return <p key={`${n.kind}-${n.skuId || ""}-${i}`} className="agri-warn">{n.message} Allowed by {allowed.approved_by_name}: {allowed.reason}</p>;
    return (
      <div key={`${n.kind}-${n.skuId || ""}-${i}`} className="agri-note-row">
        <p className={n.level === "stop" ? "agri-stop" : "agri-warn"} role={n.level === "stop" ? "alert" : undefined}>{n.message}</p>
        {n.override && biz.can("sales.create") && (
          <button type="button" className="button button-secondary button-sm" onClick={() => setAsking(n.override)}>Ask a manager to allow it</button>
        )}
      </div>
    );
  };
  const restrictedIds = needs.restricted.map((r) => r.skuId);
  const bags = checks?.bags;
  return (
    <SectionCard icon="leaf" title="Farm inputs">
      {notes.map(note)}
      {needs.banned.map((b) => <p key={b.label} className="agri-stop">{b.label} contains {b.molecule.name}, banned in India ({b.molecule.source}): it cannot be sold.</p>)}
      {needs.subsidised.length > 0 && (
        <Field label="PoS receipt number" hint={`For ${listWords(needs.subsidised)}: the receipt the PoS device printed after the farmer's thumb check. Never the Aadhaar number.`}>
          <input required maxLength={40} className="mono" value={value.posReceipt} onChange={set("posReceipt")} />
        </Field>
      )}
      {customer && bags && needs.subsidised.length > 0 && (
        <p className="small muted">Subsidised bags this month: {Number(bags.before)} so far, {Number(bags.after)} with this bill, of {bags.limit} a farmer may take here.</p>
      )}
      {needs.any && (
        <Field label={needs.barred.length ? "Crop it is for" : "Crop it is for (optional)"}>
          <input required={needs.barred.length > 0} maxLength={100} list="agri-counter-crops" value={value.crop} onChange={set("crop")} placeholder="e.g. Paddy" />
        </Field>
      )}
      <datalist id="agri-counter-crops">{(master?.crops || []).map((c) => <option key={c.key} value={c.name} />)}</datalist>
      {needs.barred.map((m) => <p key={m.code} className="agri-note">{barredWords(m)}</p>)}
      {needs.restricted.map((r) => <p key={r.skuId} className="agri-note">{r.label}: for pest-control operators and government bodies only ({r.molecules.map((m) => m.name).join(", ")}).</p>)}
      {pair && <p className="agri-stop" role="alert">{pairWords(pair)}: it cannot be sold for that crop.</p>}
      {walkIn && (
        <div className="rt-inline">
          <Field label={needs.sulphur.length ? "Farmer's name" : "Farmer's name (optional)"}><input required={needs.sulphur.length > 0} maxLength={150} value={value.farmerName} onChange={set("farmerName")} /></Field>
          <Field label={needs.sulphur.length ? "Village" : "Village (optional)"}><input required={needs.sulphur.length > 0} maxLength={100} value={value.village} onChange={set("village")} /></Field>
        </div>
      )}
      {needs.sulphur.length > 0 && <p className="agri-note">{listWords(needs.sulphur)}: sulphur's buyers go in a register with their name and address.</p>}
      {seasonCredit && (
        <div className="rt-inline">
          <Field label="Season credit (optional)">
            <select value={value.seasonCreditId} onChange={(e) => onChange({ ...value, seasonCreditId: e.target.value, season: "", seasonYear: e.target.value === "new" ? String(year) : "", dueOn: "" })}>
              <option value="">No season</option>
              {(seasons || []).map((s) => (
                <option key={s.id} value={s.id}>{seasonWord(s.season, s.season_year)} · due {dateShort(s.due_on, { year: true })}{s.credit_limit ? ` · limit ${biz.exact(s.credit_limit)}` : ""}</option>
              ))}
              <option value="new">A new season…</option>
            </select>
          </Field>
          {value.seasonCreditId === "new" && (
            <>
              <Field label="Season">
                <select required value={value.season} onChange={set("season")}>
                  <option value="">Choose…</option>
                  {SEASONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
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
      {asking && (
        <AgriOverrideDialog kind={asking} locationId={locationId} contactId={customer?.id || null} skuIds={restrictedIds}
          items={asking === "restricted_use" ? needs.restricted.map((r) => r.label) : [customer?.name].filter(Boolean)}
          onClose={() => setAsking(null)} onSaved={given} />
      )}
      {Object.values(overrides).length > 0 && (
        <p className="small muted">Allowed for this bill: {Object.values(overrides).map((o) => `${HELD[o.kind]} (${o.approved_by_name})`).join(", ")}.</p>
      )}
    </SectionCard>
  );
}
