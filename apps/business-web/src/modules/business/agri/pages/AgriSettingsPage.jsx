import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { GST_STATES } from "../../core/pages/invoice";
import { CATEGORY_WORDS } from "./agri";
import "../styles/agri.css";

// What a farm-input shop's bills are checked for, in one place: the licence
// check (on while Licences & registrations is on, with what each location
// holds), banned, crop-restricted and restricted-use molecules, seed-lot
// validity, the PoS receipt and the monthly limit of subsidised fertiliser,
// season credit and its interest, the advice printed on a bill and the
// locations that keep food or feed. Each check follows the tools that are
// switched on. Whether an insecticide not endorsed on the licence stops the
// bill is set by whoever may change the licences; the rest by whoever may
// change the settings.

// What such an insecticide does to a bill (agri/settings, endorsementCheck).
const ENDORSEMENT_CHECKS = [
  { value: "warn", label: "Warn and bill it", hint: "The bill goes through with the warning, which the counter shows and the bill's activity log keeps." },
  { value: "block", label: "Stop the bill", hint: "The bill is refused until the item or its brand is endorsed on the licence and its manufacturer's principal certificate is in force." },
];
// A restricted-use pesticide for a buyer not tagged for it (restrictedUse).
const RESTRICTED_CHECKS = [
  { value: "block", label: "Stop the bill", hint: "Only a customer tagged a pest-control operator or a government body, with the tag in force, buys it." },
  { value: "override", label: "Stop it unless a manager allows it", hint: "A manager's PIN allows that one bill; the override and its reason are kept with the bill." },
];
// Subsidised bags over a farmer's monthly limit (bagLimitMode).
const BAG_CHECKS = [
  { value: "block", label: "Stop the bill", hint: "A named farmer's subsidised bags this month are held to the limit; near it, the counter warns." },
  { value: "override", label: "Stop it unless a manager allows it", hint: "A manager's PIN allows that one bill over the limit, with its reason." },
];
const SERVICES = "catalog?kind=service&active=true";

export default function AgriSettingsPage() {
  const biz = useOpenBusiness();
  const licencesOn = biz.has("licences");
  const seesLicences = licencesOn && biz.can("licences.view");
  const [licences, setLicences] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!seesLicences) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "licences", { active: "true", limit: 100 }, controller.signal)
      .then((page) => { setLicences(page.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, seesLicences]);
  // The settings, read by everyone here; the licence check saved by whoever may change the licences, the rest by whoever may change the settings.
  const canSet = licencesOn && biz.can("licences.edit");
  const canSetMore = biz.can("settings.edit");
  const [settings, setSettings] = useState(null);
  const [check, setCheck] = useState({ saved: "", choice: "" });
  const [checkError, setCheckError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "agri/settings", undefined, controller.signal)
      .then((s) => { setSettings(s); setCheck({ saved: s.endorsementCheck, choice: s.endorsementCheck }); setCheckError(""); })
      .catch((err) => { if (!controller.signal.aborted) setCheckError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const saveCheck = async (event) => {
    event.preventDefault();
    setSaving(true);
    setCheckError("");
    try {
      const s = await businessWrite(biz.id, "agri/settings", { endorsementCheck: check.choice }, "put");
      setSettings(s);
      setCheck({ saved: s.endorsementCheck, choice: s.endorsementCheck });
      toast.success(s.endorsementCheck === "block" ? "Saved: such an insecticide now stops the bill." : "Saved: such an insecticide is now billed with a warning.");
    } catch (err) {
      setCheckError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  // For each location and category, the licence that lets it sell (in force, a renewal pending too), else the closest one.
  const held = (locationId, category) => {
    const mine = (licences || []).filter((l) => String(l.location_id) === String(locationId) && (l.covers || []).includes(category));
    return mine.find((l) => ["valid", "no_expiry", "expiring", "renewal_pending"].includes(l.state)) || mine[0] || null;
  };
  const standing = (licence) => {
    if (!licence) return <Badge tone="danger" label="None kept" />;
    if (licence.state === "renewal_pending") return <Badge tone="warning" label="Renewal pending" />;
    if (licence.state === "expiring") return <Badge tone="warning" label={`Runs out ${dateShort(licence.valid_until, { year: true })}`} />;
    if (["valid", "no_expiry"].includes(licence.state)) return <Badge tone="success" label={licence.valid_until ? `Valid until ${dateShort(licence.valid_until, { year: true })}` : "No expiry"} />;
    return <Badge tone="danger" label={licence.state === "expired" ? "Run out" : "Not yet valid"} />;
  };
  return (
    <div className="stack">
      <BusinessHeader icon="sliders" title="Farm input checks"
        description="What every bill of fertilisers, seeds and pesticides is checked for. The checks follow the tools that are switched on; what each check does when it fails is set here." />
      <SectionCard icon="shield" title="Licences at the counter"
        actions={<Badge tone={licencesOn ? "success" : "neutral"} label={licencesOn ? "On" : "Off"} />}>
        {licencesOn ? (
          <>
            <p>A fertiliser, seed or pesticide line is billed only where the selling location holds a licence in force that covers it: a fertiliser authorisation letter, a seed licence or an insecticide licence, kept under <Link to={businessPath(biz.id, "licences")}>Settings › Licences</Link>.</p>
            <p>A sale to a buyer with a GSTIN (a B2B invoice) is a wholesale sale and needs a licence for wholesale sales; any other sale needs one for retail sales. Each licence says which it is for.</p>
            <p>Past its date, an insecticide licence stays in force while its renewal is pending; a fertiliser authorisation does so only when its renewal was applied for within a month of its date; a seed licence lapses on its date. A bill under a licence kept in force this way carries a warning until the renewed date is typed.</p>
            <p>Fertiliser received from a supplier with no certificate of source (Form O) on the location's fertiliser authorisation comes in with a warning.</p>
            {check.saved ? (
              <form className="agri-setting" onSubmit={saveCheck}>
                <fieldset className="agri-choices" disabled={!canSet || saving}>
                  <legend>An insecticide not endorsed on the location's insecticide licence, or whose manufacturer's principal certificate is missing, withdrawn or out of date</legend>
                  {ENDORSEMENT_CHECKS.map((c) => (
                    <label key={c.value} className="checkbox">
                      <input type="radio" name="agri-endorsement-check" value={c.value} checked={check.choice === c.value} onChange={() => setCheck((s) => ({ ...s, choice: c.value }))} />
                      <span className="bz-two-line"><span>{c.label}</span><small className="muted">{c.hint}</small></span>
                    </label>
                  ))}
                </fieldset>
                <small className="muted">Endorsements and principal certificates are kept on each location's insecticide licence, under <Link to={businessPath(biz.id, "licences")}>Settings › Licences</Link>.{canSet ? "" : " Whoever may change the licences sets this."}</small>
                {canSet && check.choice !== check.saved && (
                  <div className="form-actions bz-start"><button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>
                )}
              </form>
            ) : null}
          </>
        ) : (
          <p>Licences & registrations is switched off, so bills are not checked against licences. An owner can switch it on under <Link to={businessPath(biz.id, "settings")}>Settings › Business tools</Link>; each location then needs its licences kept before it bills fertilisers, seeds or pesticides.</p>
        )}
        <ErrorMessage message={error} />
        {seesLicences && !licences && !error && <Loading />}
        {seesLicences && licences && (
          <table className="agri-licence-table">
            <thead><tr><th>Location</th>{Object.values(CATEGORY_WORDS).map((word) => <th key={word}>{word}</th>)}</tr></thead>
            <tbody>
              {biz.locations.filter((l) => l.active).map((location) => (
                <tr key={location.id}>
                  <th scope="row">{location.name}</th>
                  {Object.keys(CATEGORY_WORDS).map((category) => <td key={category}>{standing(held(location.id, category))}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
      <ErrorMessage message={checkError} />
      {!settings && !checkError && <Loading />}
      <SectionCard icon="leaf" title="Banned, crop-restricted and restricted-use molecules">
        <p>An item made of a banned molecule is refused when it is added and when it is billed. A molecule barred on some crops, or on a group of crops (vegetables, fruits, pulses…), is sold only once the crop the farmer is buying for is given, and never for a barred crop or one in a barred group. A crop not on the pesticide's label is billed with a warning, which the insecticide register keeps. The list, with the order behind each entry, is under <Link to={businessPath(biz.id, "molecules")}>Farm inputs › Molecules</Link>, and the crops in their groups under <Link to={businessPath(biz.id, "agri-crops")}>Farm inputs › Crops</Link>.</p>
        <p>A restricted-use molecule (aluminium phosphide, methyl bromide and others) is sold only to a customer tagged a pest-control operator or a government body, with the tag in force, on the Tagged buyers tab of <Link to={businessPath(biz.id, "farmers?tab=buyers")}>Farm inputs › Farmers & village dues</Link>. A molecule allowed only in one formulation (carbofuran 3% CG) is kept for sale only in it.</p>
        {settings && (
          <Choice name="agri-restricted-use" legend="A restricted-use pesticide for a buyer who is not tagged for it" choices={RESTRICTED_CHECKS} saved={settings.restrictedUse} canSet={canSetMore}
            onSave={async (value) => { const s = await businessWrite(biz.id, "agri/settings", { restrictedUse: value }, "put"); setSettings(s); toast.success("Saved."); }} />
        )}
      </SectionCard>
      <SectionCard icon="calendar" title="Seed lots and expired batches">
        <p>A seed lot's validity is its batch's expiry: the test date on its tag plus 9 months, and 6 months more after each passing retest, kept under <Link to={businessPath(biz.id, "agri-seed-lots")}>Stock › Seed lots</Link>. A seed receipt needs it, and a lot past it is not sold.</p>
        <p>A pesticide batch past its expiry is not sold either: keep it apart, marked not for sale, under <Link to={businessPath(biz.id, "agri-kept-apart")}>Stock › Kept apart</Link>, which is the register of expired stock until it is disposed of. Stock seized by an inspector, and samples drawn, are kept apart there too.</p>
      </SectionCard>
      <SectionCard icon="receipt" title="Subsidised fertiliser">
        <p>A subsidised fertiliser is sold through the government's PoS device too. Its line on the bill needs the receipt number the PoS device printed; no Aadhaar number is asked for or kept. <Link to={businessPath(biz.id, "agri-subsidy")}>Farm inputs › Subsidy PoS reconciliation</Link> sets the bags billed against the receipts and the PoS device's stock.</p>
        {settings && <BagLimits settings={settings} canSet={canSetMore} onSaved={(s) => { setSettings(s); toast.success("Saved."); }} />}
      </SectionCard>
      <SectionCard icon="wallet" title="Season credit">
        <p>A bill left on udhaar for a farmer can go on their credit for a season (kharif, rabi or zaid of a year), with its limit, its harvest date and its interest on overdue, kept under <Link to={businessPath(biz.id, "agri-seasons")}>Farm inputs › Season credit</Link>. The dues by village count it under <Link to={businessPath(biz.id, "farmers?tab=dues")}>Farm inputs › Farmers & village dues</Link>.</p>
        {settings && <InterestItem settings={settings} canSet={canSetMore} onSaved={(s) => { setSettings(s); toast.success("Saved."); }} />}
      </SectionCard>
      {settings && <Advisory settings={settings} canSet={canSetMore} onSaved={(s) => { setSettings(s); toast.success(s.advisoryOn ? "Saved: pesticide lines now carry their advice." : "Saved: no advice line on bills."); }} />}
      {settings && <FoodLocations settings={settings} canSet={canSetMore} onSaved={(s) => { setSettings(s); toast.success("Saved."); }} />}
    </div>
  );
}

// A choice of radio buttons, saved on its own.
function Choice({ name, legend, choices, saved, canSet, onSave }) {
  const [choice, setChoice] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(choice);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="agri-setting" onSubmit={save}>
      <fieldset className="agri-choices" disabled={!canSet || busy}>
        <legend>{legend}</legend>
        {choices.map((c) => (
          <label key={c.value} className="checkbox">
            <input type="radio" name={name} value={c.value} checked={choice === c.value} onChange={() => setChoice(c.value)} />
            <span className="bz-two-line"><span>{c.label}</span><small className="muted">{c.hint}</small></span>
          </label>
        ))}
      </fieldset>
      {!canSet && <small className="muted">Whoever may change the settings sets this.</small>}
      <ErrorMessage message={error} />
      {canSet && choice !== saved && <div className="form-actions bz-start"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>}
    </form>
  );
}

// The subsidised bags a named farmer may take in a month, by the state the selling location is in.
function BagLimits({ settings, canSet, onSaved }) {
  const biz = useOpenBusiness();
  const start = settings.bagLimits.map((l) => ({ stateCode: l.stateCode, bags: String(l.bagsPerMonth) }));
  const [rows, setRows] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = JSON.stringify(rows) !== JSON.stringify(start);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, "agri/settings", { bagLimits: rows.map((r) => ({ stateCode: r.stateCode, bagsPerMonth: Number(r.bags) })) }, "put"));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p>A named farmer's subsidised bags in a month (on the shop's own calendar, less any that came back) are held to the limit of the state the selling location is in; the counter warns from {settings.bagWarnPercent}% of it. A walk-in's bags are not counted.</p>
      {rows.length > 0 ? (
        <form className="agri-setting" onSubmit={save}>
          <table className="agri-licence-table">
            <thead><tr><th>State</th><th>Bags a month</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.stateCode}>
                  <th scope="row">{GST_STATES[r.stateCode] || "State"} ({r.stateCode})</th>
                  <td><input type="number" required min="1" max="10000" step="1" inputMode="numeric" disabled={!canSet || busy} aria-label={`Bags a month in ${GST_STATES[r.stateCode] || r.stateCode}`}
                    value={r.bags} onChange={(e) => setRows((list) => list.map((x, n) => (n === i ? { ...x, bags: e.target.value } : x)))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">{settings.defaultBagLimit} bags a month unless the state's order says otherwise.</small>
          <ErrorMessage message={error} />
          {canSet && changed && <div className="form-actions bz-start"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save the limits"}</button></div>}
        </form>
      ) : <p className="small muted">Give each location its state (Settings › Locations) to set its limit; until then {settings.defaultBagLimit} bags a month apply.</p>}
      <Choice name="agri-bag-limit" legend="Subsidised bags over the limit" choices={BAG_CHECKS} saved={settings.bagLimitMode} canSet={canSet}
        onSave={async (value) => onSaved(await businessWrite(biz.id, "agri/settings", { bagLimitMode: value }, "put"))} />
    </>
  );
}

// The service item interest on season credit is billed as (its GST slab is the item's).
function InterestItem({ settings, canSet, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(canSet ? [SERVICES] : []);
  const [value, setValue] = useState(settings.interestSkuId ? String(settings.interestSkuId) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = settings.interestSkuId ? String(settings.interestSkuId) : "";
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, "agri/settings", { interestSkuId: value || null }, "put"));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="agri-setting" onSubmit={save}>
      <p>Interest worked out on a season's overdue bills is billed only when someone confirms it, as a line of this service item: its GST slab is the item's. Make a service item for it under Products first.</p>
      <label className="field">
        <span>Interest is billed as</span>
        {canSet ? (
          <select value={value} disabled={busy} onChange={(e) => setValue(e.target.value)}>
            <option value="">Not chosen: interest is not billed</option>
            {(options?.[SERVICES] || []).map((s) => <option key={s.id} value={s.id}>{s.label}{s.tax_rate !== undefined ? ` · GST ${Number(s.tax_rate)}%` : ""}</option>)}
            {settings.interestItem && !(options?.[SERVICES] || []).some((s) => String(s.id) === saved) && <option value={saved}>{settings.interestItem.label}</option>}
          </select>
        ) : <strong>{settings.interestItem ? settings.interestItem.label : "Not chosen"}</strong>}
      </label>
      <ErrorMessage message={error} />
      {canSet && value !== saved && <div className="form-actions bz-start"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>}
    </form>
  );
}

// The advice line under each pesticide on the bill: the dose, the waiting days before harvest and the protection to wear.
function Advisory({ settings, canSet, onSaved }) {
  const biz = useOpenBusiness();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(on) {
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, "agri/settings", { advisoryOn: on }, "put"));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SectionCard icon="info" title="Advice on the bill" actions={<Badge tone={settings.advisoryOn ? "success" : "neutral"} label={settings.advisoryOn ? "On" : "Off"} />}>
      <p>Each pesticide line on the bill carries a line of advice from the item's details: its dose an acre, the days to wait before harvest and the protection to wear. An item without them carries none.</p>
      <label className="checkbox">
        <input type="checkbox" checked={settings.advisoryOn} disabled={!canSet || busy} onChange={(e) => change(e.target.checked)} /> Print the advice line on bills
      </label>
      <ErrorMessage message={error} />
    </SectionCard>
  );
}

// The locations that also keep food or animal feed: a pesticide received there is warned about (rule 10C).
function FoodLocations({ settings, canSet, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const saved = settings.foodLocations.map(String);
  const [chosen, setChosen] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState([]);
  const changed = JSON.stringify([...chosen].sort()) !== JSON.stringify([...saved].sort());
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = await businessWrite(biz.id, "agri/settings", { foodLocations: chosen.map(Number) }, "put");
      setChosen(s.foodLocations.map(String));
      setWarnings(s.warnings || []);
      onSaved(s);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SectionCard icon="home" title="Food or feed kept with pesticides">
      <p>An insecticide is not kept or displayed with food or animal feed (Insecticides Rules 1971, rule 10C). Mark the locations that also keep food or feed: a pesticide received there comes in with a warning, and the bell reminds while such a location holds pesticides.</p>
      <form className="agri-setting" onSubmit={save}>
        <fieldset className="agri-choices" disabled={!canSet || busy}>
          <legend>Locations that keep food or feed</legend>
          {locations.map((l) => (
            <label key={l.id} className="checkbox">
              <input type="checkbox" checked={chosen.includes(String(l.id))}
                onChange={(e) => setChosen((list) => (e.target.checked ? [...list, String(l.id)] : list.filter((x) => x !== String(l.id))))} /> {l.name}
            </label>
          ))}
        </fieldset>
        {!canSet && <small className="muted">Whoever may change the settings sets this.</small>}
        <ErrorMessage message={error} />
        {warnings.map((w) => <p key={w} className="agri-warn">{w}</p>)}
        {canSet && changed && <div className="form-actions bz-start"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>}
      </form>
    </SectionCard>
  );
}
