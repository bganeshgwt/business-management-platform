import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import SectionCard from "../../../components/SectionCard";
import StatusBadge from "../../../components/StatusBadge";
import { getErrorMessage } from "../../../services/api";
import { formatLabel } from "../../../services/restaurantFormats";
import { relative } from "@bmp/shared/format";
import { listPlatformBusinesses } from "../services/platform.service";
import { PLAN_STATES, dayWords, endsWords, planOfRow, stateWords } from "../consoleWords";
import "../styles/console.css";

// Platform › Businesses: every business on the platform, restaurants
// included, with the state of its plan, its plan and add-ons, when its time
// ends, its owner and when it was last used. Filters for the state, the type,
// the plan and time ending soon live in the address (?state=trial, ?type=,
// ?plan=, ?endsWithin=30, ?q=), so another screen can link to a filtered
// list. A row opens the business's page, where the platform gives it time,
// changes its plan and records its payments. Nothing here shows a business's
// bills or customers.
const ENDS = [["", "Any time"], ["7", "Ends within 7 days"], ["30", "Ends within 30 days"], ["90", "Ends within 90 days"]];
const FILTERS = ["q", "state", "type", "plan", "endsWithin"];
const PERIODS = { month: "monthly", year: "yearly" };

export default function PlatformBusinessesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(FILTERS.map((key) => [key, params.get(key) || ""])), [params]);
  const [search, setSearch] = useState(filters.q);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // Each filter changes its own part of the address, from the address as it
  // is when it runs, so the search box's late write keeps a filter set meanwhile.
  const setFilter = (key, value) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "type") next.delete("plan");
    return next;
  }, { replace: true });

  // The search box writes the address once typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.trim() !== filters.q) setFilter("q", search.trim());
    }, 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    let live = true;
    const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
    listPlatformBusinesses(query)
      .then((result) => { if (live) { setData(result); setError(""); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [filters]);

  const plans = (data?.plans || []).filter((p) => !filters.type || p.businessType === filters.type);

  const columns = useMemo(() => [
    { key: "name", header: "Business", value: (b) => b.name, mobile: "title", pin: true, csv: (b) => `${b.name} (${b.code})`,
      render: (b) => <span className="bz-two-line"><Link to={`/platform/businesses/${b.id}`}><strong>{b.name}</strong></Link><small className="muted mono">{b.code}</small></span> },
    { key: "type", header: "Type", value: (b) => (b.restaurant_id ? formatLabel(b.format) : b.type_name), mobile: "subtitle" },
    { key: "state", header: "State", type: "status", value: (b) => stateWords(b.state).label, mobile: "show",
      render: (b) => <StatusBadge status={b.state} label={stateWords(b.state).label} tone={stateWords(b.state).tone} /> },
    { key: "plan", header: "Plan", value: (b) => (b.plan_name ? `${b.plan_name}, ${PERIODS[b.billing_period] || b.billing_period}` : "") },
    { key: "addons", header: "Add-ons", type: "number", value: (b) => b.addons },
    { key: "ends", header: "Ends on", type: "date", value: (b) => b.access_ends_on || "", mobile: "show",
      render: (b) => <span title={endsWords(planOfRow(b))}>{b.access_ends_on ? dayWords(b.access_ends_on) : b.state === "given" ? "No end date" : "—"}</span> },
    { key: "owners", header: "Owner", value: (b) => (b.owners || []).map((o) => o.name).join(", "),
      render: (b) => (b.owners || []).map((o) => <span key={o.id} className="bz-two-line"><span>{o.name}</span><small className="muted">{o.email}</small></span>) },
    { key: "place", header: "City, state", value: (b) => [b.city, b.state_name].filter(Boolean).join(", ") },
    { key: "created", header: "Created", type: "date", value: (b) => b.created_at },
    { key: "lastActive", header: "Last active", type: "datetime", value: (b) => b.last_active_at || "", render: (b) => (b.last_active_at ? relative(b.last_active_at) : "Never") },
    { key: "status", header: "Switched", value: (b) => (b.status === "active" ? "On" : "Off"), defaultHidden: true },
    { key: "people", header: "People", type: "number", value: (b) => b.people, defaultHidden: true },
    { key: "locations", header: "Locations", type: "number", value: (b) => b.locations, defaultHidden: true },
    { key: "gstin", header: "GSTIN", value: (b) => b.gstin || "", className: "mono", defaultHidden: true },
  ], []);

  return (
    <div className="stack pc-page">
      <PageHeader icon="store" eyebrow="Platform" title="Businesses"
        description="Every business on the platform, restaurants included: the state of its plan and when its time ends. Open one to give it time, change its plan or record its payment."
        primary={<Link className="button" to="/platform/businesses/new"><Icon name="plus" size={16} /> New business</Link>} />
      <SectionCard icon="list" title="Businesses" flush>
        <DataGrid id="platform-businesses" caption="Businesses" columns={columns} rows={data?.items || []} loading={!data && !error} error={error}
          rowNoun={["business", "businesses"]} rowClassName={(b) => (b.status !== "active" || b.state === "ended" ? "dg-tone-muted" : "")}
          onRowClick={(b) => navigate(`/platform/businesses/${b.id}`)} exportName="platform-businesses" search={false}
          toolbar={(
            <span className="pc-toolbar">
              <input type="search" placeholder="Name, code, city or GSTIN" aria-label="Search businesses" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select aria-label="State" value={filters.state} onChange={(e) => setFilter("state", e.target.value)}>
                <option value="">Every state</option>
                {Object.entries(PLAN_STATES).filter(([code]) => code !== "unmanaged").map(([code, words]) => <option key={code} value={code}>{words.label}</option>)}
              </select>
              <select aria-label="Type" value={filters.type} onChange={(e) => setFilter("type", e.target.value)}>
                <option value="">Every type</option>
                {(data?.types || []).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
              </select>
              <select aria-label="Plan" value={filters.plan} onChange={(e) => setFilter("plan", e.target.value)}>
                <option value="">Every plan</option>
                {plans.map((p) => <option key={p.code} value={p.code}>{filters.type ? p.name : `${p.name} (${(data?.types || []).find((t) => t.code === p.businessType)?.name || p.businessType})`}</option>)}
              </select>
              <select aria-label="Ends" value={filters.endsWithin} onChange={(e) => setFilter("endsWithin", e.target.value)}>
                {ENDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </span>
          )}
          empty="No businesses match" emptyHint="Clear a filter, or set up a business for a customer." emptyIcon="store" />
      </SectionCard>
    </div>
  );
}
