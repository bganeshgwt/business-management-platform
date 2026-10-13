import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import SectionCard from "../../../components/SectionCard";
import StatusBadge from "../../../components/StatusBadge";
import Icon from "../../../components/Icon";
import { ErrorMessage, SuccessMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import FormDialog from "../../business/core/pages/FormDialog";
import { Field } from "../../business/core/pages/ui";
import { NewBusinessFields } from "../../business/core/pages/NewBusinessForm";
import { businessBody, emptyBusiness } from "../../business/core/pages/newBusiness";
import { createPlatformBusiness, listPlatformBusinesses, resetPlatformBusinessOwner, setPlatformBusinessStatus } from "../services/platform.service";

// Platform › Businesses: every real business of every type but restaurant
// (restaurants have their own console). Create one for a customer with its
// owner's login, switch one off and on, and give a locked-out owner a new
// password. Nothing here shows a business's bills or customers.
export default function PlatformBusinessesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState({ q: "", type: "", status: "" });
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);

  const load = useCallback(() => {
    listPlatformBusinesses({ q: filters.q || undefined, type: filters.type || undefined, status: filters.status || undefined })
      .then((result) => { setData(result); setError(""); })
      .catch((err) => setError(getErrorMessage(err)));
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (business) => {
    try {
      const next = business.status === "active" ? "inactive" : "active";
      await setPlatformBusinessStatus(business.id, next);
      setNotice(`${business.name} ${next === "active" ? "switched on" : "switched off"}.`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const columns = useMemo(() => [
    { key: "name", header: "Business", value: (b) => b.name, mobile: "title", pin: true,
      render: (b) => <span className="bz-two-line"><strong>{b.name}</strong><small className="muted mono">{b.code}</small></span> },
    { key: "type", header: "Type", value: (b) => b.type_name, mobile: "subtitle" },
    { key: "owners", header: "Owner", value: (b) => (b.owners || []).map((o) => o.name).join(", "),
      render: (b) => (b.owners || []).map((o) => <span key={o.id} className="bz-two-line"><span>{o.name}</span><small className="muted">{o.email}</small></span>) },
    { key: "city", header: "City", value: (b) => b.city || "" },
    { key: "gstin", header: "GSTIN", value: (b) => b.gstin || "", className: "mono", defaultHidden: true },
    { key: "locations", header: "Locations", type: "number", value: (b) => b.locations },
    { key: "people", header: "People", type: "number", value: (b) => b.people },
    { key: "money", header: "Currency · zone", value: (b) => `${b.currency} · ${b.timezone}`, defaultHidden: true },
    { key: "created", header: "Created", type: "date", value: (b) => b.created_at },
    { key: "status", header: "Status", type: "status", value: (b) => b.status,
      render: (b) => <StatusBadge status={b.status} label={b.status === "active" ? "Active" : "Switched off"} />, mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (b) => (
      <span className="bz-actions">
        <button type="button" className="chip-button" onClick={() => toggle(b)}>{b.status === "active" ? "Switch off" : "Switch on"}</button>
        {(b.owners || []).length > 0 && <button type="button" className="chip-button" onClick={() => setResetting(b)}>Owner password</button>}
      </span>
    ) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <div className="stack">
      <PageHeader icon="store" eyebrow="Platform" title="Businesses"
        description="Every business on the platform except restaurants (see Restaurants). Add one for a customer with its owner's login; the owner then sets up products, staff and locations."
        actions={<button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Add a business</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="list" title="Businesses">
        <DataGrid id="platform-businesses" caption="Businesses" columns={columns} rows={data?.items || []} loading={!data && !error}
          rowNoun={["business", "businesses"]} rowClassName={(b) => (b.status !== "active" ? "dg-tone-muted" : "")}
          toolbar={(
            <span className="bz-actions">
              <input type="search" placeholder="Name, code, city or GSTIN" aria-label="Search businesses" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
              <select aria-label="Type" value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
                <option value="">Every type</option>
                {(data?.types || []).filter((t) => t.code !== "restaurant").map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
              </select>
              <select aria-label="Status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                <option value="">Any status</option><option value="active">Active</option><option value="inactive">Switched off</option>
              </select>
            </span>
          )}
          empty="No businesses yet" emptyHint="Add the first one for a customer." emptyIcon="store" />
      </SectionCard>
      {creating && <CreateBusinessDialog types={data?.types || []} onClose={() => setCreating(false)}
        onSaved={(result) => { setCreating(false); setNotice(`${result.business.name} created. ${result.owner.created ? `${result.owner.name} can now sign in with the email and password you set.` : `${result.owner.name} will find it in their business switcher.`}`); load(); }} />}
      {resetting && <OwnerPasswordDialog business={resetting} onClose={() => setResetting(null)}
        onSaved={(owner) => { setResetting(null); setNotice(`New password set for ${owner.name}. Their open sessions have ended.`); }} />}
    </div>
  );
}

function CreateBusinessDialog({ types, onClose, onSaved }) {
  const [form, setForm] = useState(emptyBusiness);
  const [owner, setOwner] = useState({ email: "", name: "", mobile: "", password: "" });
  const setO = (key) => (e) => setOwner((o) => ({ ...o, [key]: e.target.value }));
  return (
    <FormDialog title="Add a business" icon="store" width={780} onClose={onClose} onSaved={onSaved} submitLabel="Create business"
      description="The business and its owner's login. If the owner already has a login (the same email), the business is added to it."
      onSubmit={() => createPlatformBusiness({ ...businessBody(form), owner: { ...owner, email: owner.email.trim(), name: owner.name.trim(), mobile: owner.mobile.trim() } })}>
      <NewBusinessFields form={form} setForm={setForm} types={types} />
      <p className="field-wide muted small"><strong>Owner.</strong> Name and password are needed only for a new login.</p>
      <Field label="Owner's email"><input type="email" required maxLength={150} value={owner.email} onChange={setO("email")} /></Field>
      <Field label="Owner's name"><input maxLength={150} value={owner.name} onChange={setO("name")} /></Field>
      <Field label="Owner's mobile"><input maxLength={20} value={owner.mobile} onChange={setO("mobile")} /></Field>
      <Field label="Owner's password" hint="8 to 72 characters; they can change it in My profile."><input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={owner.password} onChange={setO("password")} /></Field>
    </FormDialog>
  );
}

function OwnerPasswordDialog({ business, onClose, onSaved }) {
  const [userId, setUserId] = useState(String(business.owners[0].id));
  const [password, setPassword] = useState("");
  return (
    <FormDialog title={`Owner's password: ${business.name}`} icon="key" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Set password"
      description="For an owner locked out of their own business. Their open sessions end."
      onSubmit={() => resetPlatformBusinessOwner(business.id, Number(userId), password)}>
      <Field label="Owner" wide>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          {business.owners.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.email}</option>)}
        </select>
      </Field>
      <Field label="New password" wide><input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    </FormDialog>
  );
}
