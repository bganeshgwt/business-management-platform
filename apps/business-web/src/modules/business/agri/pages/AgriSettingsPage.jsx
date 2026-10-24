import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort } from "@bmp/shared/format";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { CATEGORY_WORDS } from "./agri";

// What a farm-input shop's bills are checked for, in one place: the licence
// check (on while Licences & registrations is on, with what each location
// holds), banned and crop-restricted molecules, seed-lot validity, the PoS
// receipt of subsidised fertiliser and season credit. Nothing here is a
// setting to change: each check follows the tools that are switched on.
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
  // For each location and category, the licence that lets it sell (in force), else the closest one.
  const held = (locationId, category) => {
    const mine = (licences || []).filter((l) => String(l.location_id) === String(locationId) && (l.covers || []).includes(category));
    return mine.find((l) => ["valid", "no_expiry", "expiring"].includes(l.state)) || mine[0] || null;
  };
  const standing = (licence) => {
    if (!licence) return <Badge tone="danger" label="None kept" />;
    if (licence.state === "expiring") return <Badge tone="warning" label={`Runs out ${dateShort(licence.valid_until, { year: true })}`} />;
    if (["valid", "no_expiry"].includes(licence.state)) return <Badge tone="success" label={licence.valid_until ? `Valid until ${dateShort(licence.valid_until, { year: true })}` : "No expiry"} />;
    return <Badge tone="danger" label={licence.state === "expired" ? "Run out" : "Not yet valid"} />;
  };
  return (
    <div className="stack">
      <BusinessHeader icon="sliders" title="Farm input checks"
        description="What every bill of fertilisers, seeds and pesticides is checked for. The checks follow the tools that are switched on; there is nothing to set here." />
      <SectionCard icon="shield" title="Licences at the counter"
        actions={<Badge tone={licencesOn ? "success" : "neutral"} label={licencesOn ? "On" : "Off"} />}>
        {licencesOn ? (
          <p>A fertiliser, seed or pesticide line is billed only where the selling location holds a licence in force that covers it: a fertiliser authorisation letter, a seed licence or an insecticide licence, kept under <Link to={businessPath(biz.id, "licences")}>Settings › Licences</Link>.</p>
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
