import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { MOLECULE_STATUS, listWords } from "./agri";

// The molecule master: the molecules a shop cannot sell freely, each with
// the order it comes from. Platform data, the same for every shop and read
// only here. Every bill is checked against it: an item made of a banned
// molecule is never sold, and one barred on some crops is sold only once the
// crop the farmer is buying for is given.
export default function MoleculesPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "agri/molecules", undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const columns = useMemo(() => [
    { key: "name", header: "Molecule", value: (m) => m.name, mobile: "title", pin: true },
    { key: "status", header: "Status", type: "status", value: (m) => MOLECULE_STATUS[m.status]?.label || m.status, filter: "select",
      render: (m) => <Badge tone={MOLECULE_STATUS[m.status]?.tone} label={MOLECULE_STATUS[m.status]?.label || m.status} />, mobile: "show" },
    { key: "crops", header: "Not to be used on", value: (m) => m.crops.map((c) => c.name).join(", "),
      render: (m) => (m.crops.length ? listWords(m.crops.map((c) => c.name.toLowerCase())) : <span className="muted">—</span>) },
    { key: "restriction", header: "Rule", value: (m) => m.restriction || "", render: (m) => m.restriction || <span className="muted">—</span>, minWidth: 220 },
    { key: "source", header: "Source", value: (m) => m.source, minWidth: 220, mobile: "subtitle" },
  ], []);
  const counts = (data?.molecules || []).reduce((n, m) => ({ ...n, [m.status]: (n[m.status] || 0) + 1 }), {});
  return (
    <div className="stack">
      <BusinessHeader icon="leaf" title="Molecules"
        description="The molecules a shop cannot sell freely, each with the order it comes from. Every bill is checked against this list: an item made of a banned molecule is never sold, and one barred on some crops is sold only for a crop it may be used on." />
      <SectionCard flush icon="leaf" title={data ? `${counts.banned || 0} banned · ${counts.crop_restricted || 0} barred on some crops · ${counts.restricted_use || 0} restricted` : "The molecule list"}>
        <DataGrid id="agri-molecules" caption="Molecules" columns={columns} rows={data?.molecules || []} rowKey={(m) => m.code} loading={!data && !error} error={data ? "" : error}
          onRetry={() => setVersion((n) => n + 1)} rowNoun={["molecule", "molecules"]} defaultSort={{ key: "status", direction: "asc" }}
          empty="No molecules listed" emptyIcon="leaf" />
      </SectionCard>
      <p className="small muted">The platform keeps this list and adds to it as orders change; it holds only the entries whose orders are cited here, so a molecule not on it is not cleared by it. A crop given at the counter is matched to the crops listed (sorghum and jowar are the same crop).</p>
    </div>
  );
}
