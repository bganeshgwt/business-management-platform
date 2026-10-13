import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import useAuth from "../../../../hooks/useAuth";
import useBusiness from "../../../../hooks/useBusiness";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { ErrorMessage, ScreenLoading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { businessRead, createBusiness, linkRestaurant, provisionBusinesses } from "../../../../services/business.service";
import { AddBusinessDialog } from "./NewBusinessForm";
import { moneyShort } from "../../../../services/format";
import { businessPath, TYPE_ICONS } from "../../../../services/businessNav";
import "../styles/business-admin.css";

// /business-admin with no business chosen: go to the one this person last
// opened (or the old ?business= link), otherwise list their businesses.
// ?all shows the list itself (the switcher links here).
export default function BusinessAdminPage() {
  const { user } = useAuth();
  const { directory, directoryError, businesses, switchTo, reloadDirectory } = useBusiness();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  if (!directory && !directoryError) {
    return <ScreenLoading label="Loading your businesses…" />;
  }

  const legacy = params.get("business");
  if (legacy && businesses.some((b) => String(b.id) === legacy)) {
    return <Navigate to={businessPath(legacy)} replace />;
  }
  const recent = [...businesses].filter((b) => b.last_opened_at && b.business_type !== "restaurant")
    .sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)))[0];
  if (recent && !legacy && !params.has("all")) {
    return <Navigate to={businessPath(recent.id)} replace />;
  }

  const admin = user.permissions.includes("restaurant.settings.manage") || user.permissions.includes("platform.restaurants.manage");
  const run = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await reloadDirectory();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const linked = businesses.some((b) => b.is_signed_in_restaurant);
  // Owners (and a restaurant's admin) may start another business of their own.
  const canAdd = businesses.some((b) => b.full_access && !b.is_demo) || user.roles.includes("RESTAURANT_ADMIN");
  const types = Object.entries(directory?.types || {}).map(([code, t]) => ({ code, name: t.name }));
  const term = q.trim().toLowerCase();
  const shown = term ? businesses.filter((b) => `${b.name} ${b.type_name} ${b.role_name}`.toLowerCase().includes(term)) : businesses;

  return (
    <div className="stack">
      <PageHeader icon="store" eyebrow="Business Admin" title="Your businesses"
        description="Open a business to manage it. Each business keeps its own products, stock, sales and staff access." />
      <ErrorMessage message={directoryError || error} />
      <SectionCard icon="grid" title="Businesses you can open" description="Today's figures for each one. The same list is in the switcher at the top of every screen."
        actions={businesses.length > 6 && (
          <label className="bz-chooser-search">
            <Icon name="search" size={16} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a business" aria-label="Find a business" />
          </label>
        )}>
        {businesses.length === 0 ? (
          <p className="muted">You are not a member of any business yet. Ask the owner of a business to give you access.</p>
        ) : shown.length === 0 ? (
          <p className="muted">No business matches “{q}”.</p>
        ) : (
          <div className="bz-business-grid">
            {shown.map((business) => <BusinessCard key={business.id} business={business} onOpen={() => switchTo(business)} />)}
          </div>
        )}
        <div className="form-actions bz-start">
          {canAdd && <button type="button" className="button" onClick={() => setAdding(true)}>Add a business</button>}
          {user.roles.includes("RESTAURANT_ADMIN") && !linked && (
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => run(linkRestaurant)}>Link my restaurant</button>
          )}
          {directory?.developmentSwitching && admin && (
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => run(provisionBusinesses)}>
              {busy ? "Creating businesses…" : "Set up demo businesses"}
            </button>
          )}
        </div>
        {directory?.developmentSwitching && admin && (
          <p className="muted small">
            The button creates one empty demo business of each type, named after you. To fill them with sample products and sales, ask your administrator to load the sample data.
          </p>
        )}
      </SectionCard>
      {adding && <AddBusinessDialog types={types} onClose={() => setAdding(false)} submit={createBusiness}
        onSaved={async (business) => { setAdding(false); await reloadDirectory(); switchTo(business); }} />}
    </div>
  );
}

// A demo is named "Demo · Grocery & kirana — Owner name": the part that tells
// the businesses apart leads, and the owner's name is a quiet second line.
function splitName(name) {
  const at = String(name).lastIndexOf(" — ");
  return at > 0 ? [name.slice(0, at), name.slice(at + 3)] : [name, ""];
}

// One business with what matters today: sales, what customers owe and the
// things waiting (low stock, expiring batches, broken promises, repairs ready,
// orders to dispatch). Figures only for what this person may see.
function BusinessCard({ business, onOpen }) {
  const restaurant = business.business_type === "restaurant";
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    if (restaurant) return undefined;
    const controller = new AbortController();
    businessRead(business.id, "summary", undefined, controller.signal).then(setSummary).catch(() => {});
    return () => controller.abort();
  }, [business.id, restaurant]);
  // Only a demo's name carries its owner after " — "; a real name is shown whole.
  const [name, owner] = business.is_demo ? splitName(business.name) : [business.name, ""];
  const alerts = summary ? ["low_stock", "expiring_soon", "promises_broken", "repairs_ready", "orders_to_dispatch"].reduce((n, key) => n + Number(summary[key] || 0), 0) : 0;
  const figures = summary ? [
    "sales_today" in summary && `Today ${moneyShort(summary.sales_today)}`,
    "receivables_owed" in summary && Number(summary.receivables_owed) > 0 && `${["grocery", "supermarket", "books"].includes(business.business_type) ? "Udhaar" : "Owed"} ${moneyShort(summary.receivables_owed)}`,
    alerts > 0 && `${alerts} to look at`,
  ].filter(Boolean) : [];
  return (
    <button type="button" className="bz-business-card" onClick={onOpen}
      disabled={restaurant && !business.is_signed_in_restaurant} title={business.name}>
      <span className={`bsw-type bsw-type-${business.business_type}`} aria-hidden="true">
        <Icon name={TYPE_ICONS[business.business_type] || "store"} size={18} />
      </span>
      <span className="bz-business-card-text">
        <strong>{name}</strong>
        <small>{business.type_name} · {business.role_name}{owner ? ` · ${owner}` : ""}</small>
        {figures.length > 0 && <span className="bz-business-figures">{figures.map((f, i) => <span key={f} className={i === 2 ? "is-alert" : ""}>{f}</span>)}</span>}
        {restaurant && <span className="bz-business-figures"><span>{business.is_signed_in_restaurant ? "Opens the restaurant admin" : "Sign in to that restaurant to manage it"}</span></span>}
      </span>
    </button>
  );
}
