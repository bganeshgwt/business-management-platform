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
import { useOpenBusiness } from "../../core/pages/hooks";
import { CATEGORY_WORDS } from "./agri";
import "../styles/agri.css";

// What a farm-input shop's bills are checked for, in one place: the licence
// check (on while Licences & registrations is on, with what each location
// holds), banned and crop-restricted molecules, seed-lot validity, the PoS
// receipt of subsidised fertiliser and season credit. Each check follows the
// tools that are switched on. The one setting is whether an insecticide not
// endorsed on the licence, or without its manufacturer's principal
// certificate in force, is billed with a warning or stops the bill; whoever
// may change the licences sets it.

// What such an insecticide does to a bill (agri/settings, endorsementCheck).
const ENDORSEMENT_CHECKS = [
  { value: "warn", label: "Warn and bill it", hint: "The bill goes through with the warning, which the counter shows and the bill's activity log keeps." },
  { value: "block", label: "Stop the bill", hint: "The bill is refused until the item or its brand is endorsed on the licence and its manufacturer's principal certificate is in force." },
];

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
  // The setting, read by everyone here and saved by whoever may change the licences.
  const canSet = licencesOn && biz.can("licences.edit");
  const [check, setCheck] = useState({ saved: "", choice: "" });
  const [checkError, setCheckError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!licencesOn) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "agri/settings", undefined, controller.signal)
      .then((s) => { setCheck({ saved: s.endorsementCheck, choice: s.endorsementCheck }); setCheckError(""); })
      .catch((err) => { if (!controller.signal.aborted) setCheckError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, licencesOn]);
  const saveCheck = async (event) => {
    event.preventDefault();
    setSaving(true);
    setCheckError("");
    try {
      const s = await businessWrite(biz.id, "agri/settings", { endorsementCheck: check.choice }, "put");
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
        description="What every bill of fertilisers, seeds and pesticides is checked for. The checks follow the tools that are switched on; the one thing to set is whether an insecticide the licence does not cover is billed with a warning or stops the bill." />
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
            <ErrorMessage message={checkError} />
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
      <SectionCard icon="leaf" title="Banned and crop-restricted molecules">
        <p>An item made of a banned molecule is refused when it is added and when it is billed. A molecule barred on some crops is sold only once the crop the farmer is buying for is given, and never for a barred crop. The list, with the order behind each entry, is under <Link to={businessPath(biz.id, "molecules")}>Farm inputs › Molecules</Link>.</p>
      </SectionCard>
      <SectionCard icon="calendar" title="Seed lots and expired batches">
        <p>A seed lot's validity is its batch's expiry: the test date on its tag plus 9 months, and 6 months more after a passing retest. A seed receipt needs it, and a lot past it is not sold. A pesticide batch past its expiry is not sold either: keep it apart, marked not for sale.</p>
      </SectionCard>
      <SectionCard icon="receipt" title="Subsidised fertiliser">
        <p>A subsidised fertiliser is sold through the government's PoS device too. Its line on the bill needs the receipt number the PoS device printed; no Aadhaar number is asked for or kept. <Link to={businessPath(biz.id, "agri-subsidy")}>Farm inputs › Subsidy PoS reconciliation</Link> sets the bags billed against the receipts and the PoS device's stock.</p>
      </SectionCard>
      <SectionCard icon="wallet" title="Season credit">
        <p>A bill left on udhaar for a farmer can carry the season it is for (kharif, rabi or zaid of a year) and the harvest date it falls due; the dues by village count it under <Link to={businessPath(biz.id, "farmers?tab=dues")}>Farm inputs › Farmers & village dues</Link>.</p>
      </SectionCard>
    </div>
  );
}
