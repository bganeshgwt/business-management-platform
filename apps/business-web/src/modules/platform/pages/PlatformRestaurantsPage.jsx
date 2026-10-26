import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../components/PageHeader";
import Modal from "../../../components/Modal";
import ConfirmDialog from "../../../components/ConfirmDialog";
import ActionMenu from "../../../components/ActionMenu";
import DataGrid from "../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../components/DataGrid/useGridLayout";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../components/StatTile";
import SectionCard from "../../../components/SectionCard";
import SuccessCheck from "../../../components/SuccessCheck";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../components/Feedback";
import {
  createPlatformRestaurant,
  listPlatformAdmins,
  listPlatformRestaurants,
  resetPlatformAdminPassword,
  setPlatformRestaurantStatus,
} from "../services/platform.service";
import { getErrorMessage } from "../../../services/api";
import { count } from "@bmp/shared/format";
import "../../../styles/access.css";
import "../../../styles/staff.css";
import { formatLabel } from "../../../services/restaurantFormats";

// The platform console: every restaurant on the platform, for the platform's
// own super admin. Add one (with everything it starts with and its first
// admin), switch one off and on again, give a locked-out owner a new
// password. Nothing here shows a restaurant's bills, guests or sales.

// Rows per page to start with; the grid's pager offers 25, 50 and 100.
const PAGE = 25;
// The most the API hands back in one request (see platform.controller.js).
const API_MAX = 200;

const lastSeen = (value) => {
  if (!value) {
    return "Never";
  }

  const minutes = Math.round((Date.now() - new Date(value)) / 60000);

  if (minutes < 60) {
    return minutes <= 1 ? "Just now" : `${minutes} min ago`;
  }

  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)} h ago`;
  }

  const daysAgo = Math.round(minutes / (60 * 24));
  return daysAgo < 45 ? `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago` : new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

const STATUS_VIEWS = [
  ["", "All"],
  ["active", "Active"],
  ["inactive", "Switched off"],
];

export default function PlatformRestaurantsPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // The rows-per-page this viewer chose last time, so the first request
  // already asks for it.
  const [limit, setLimit] = useState(() => rememberedPageSize("platform-restaurants", PAGE));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState(null);
  const [admins, setAdmins] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      listPlatformRestaurants({ status: status || undefined, search: search.trim() || undefined, limit, offset })
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [status, search, offset, limit]
  );

  // "Export CSV" takes every restaurant that matches, not only the page on
  // show: the same list call, a page of 200 at a time.
  const fetchAll = async () => {
    const all = [];

    for (let at = 0; ; at += API_MAX) {
      const result = await listPlatformRestaurants({ status: status || undefined, search: search.trim() || undefined, limit: API_MAX, offset: at });
      all.push(...result.items);

      if (result.items.length === 0 || all.length >= result.total) {
        return all;
      }
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async () => {
    setBusy(true);

    try {
      const result = await setPlatformRestaurantStatus(toggling.id, toggling.status === "active" ? "inactive" : "active");
      setSuccess(result.message);
      setToggling(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setToggling(null);
    } finally {
      setBusy(false);
    }
  };

  const counts = data?.counts;

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="store"
        eyebrow="Platform"
        title="Restaurants"
        description="Every restaurant on the platform: add one with its first admin, switch one off or on, and help an owner who is locked out. No restaurant's bills, guests or sales are shown here."
        action={
          <button type="button" className="button" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add restaurant
          </button>
        }
      />

      {/* A list that failed to load says so inside the list (with Try
          again); this line is for everything else. */}
      <ErrorMessage message={data ? error : ""} />
      <SuccessMessage message={success} />

      {counts && (
        <div className="stat-grid">
          <StatTile icon="store" tone="primary" label="Restaurants" value={count(counts.total)} note="on the platform" />
          <StatTile icon="check-circle" tone="success" label="Active" value={count(counts.active)} note="their staff can sign in" />
          <StatTile icon="ban" tone={counts.inactive ? "warning" : "neutral"} label="Switched off" value={count(counts.inactive)} note="staff told the restaurant is not active" />
        </div>
      )}

      <SectionCard icon="list" title="All restaurants" description="Most recently active first." flush actions={data && <span className="acc-count">{count(data.total)} shown</span>}>
        <DataGrid
          id="platform-restaurants"
          caption="Restaurants on the platform"
          columns={[
            {
              key: "name",
              header: "Restaurant",
              value: (row) => row.name,
              mobile: "title",
              pin: true,
              csv: (row) => `${row.name} (${row.code})`,
              render: (row) => (
                <span className="acc-who-text">
                  <strong>{row.name}</strong>
                  <span className="muted small mono">
                    {row.code}
                    {row.format && row.format !== "restaurant" ? ` · ${formatLabel(row.format)}` : ""}
                    {row.contact ? ` · ${row.contact}` : ""}
                  </span>
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (row) => row.status,
              mobile: "subtitle",
              csv: (row) => row.statusLabel,
              render: (row) => (
                <span className={`badge status-badge ${row.status === "active" ? "badge-active" : "badge-inactive"}`}>
                  <span className="badge-dot" aria-hidden="true" />
                  {row.statusLabel}
                </span>
              ),
            },
            { key: "outlets", header: "Outlets", type: "number", value: (row) => row.outlets, mobile: "show" },
            {
              key: "logins",
              header: "Logins",
              type: "number",
              value: (row) => row.activeUsers,
              mobile: "show",
              render: (row) => (
                <>
                  {row.activeUsers}
                  {row.users > row.activeUsers && <span className="muted small"> of {row.users}</span>}
                </>
              ),
            },
            {
              key: "lastActivity",
              header: "Last activity",
              type: "datetime",
              value: (row) => row.lastActivity,
              mobile: "show",
              render: (row) => <span className="small">{lastSeen(row.lastActivity)}</span>,
            },
            {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (row) => (
                <div className="row-actions">
                  <button type="button" className="chip-button" onClick={() => setAdmins({ restaurant: row })}>
                    <Icon name="key" size={14} /> Admins
                  </button>
                  <ActionMenu
                    label={`More for ${row.name}`}
                    items={[
                      row.status === "active"
                        ? { label: "Switch off", icon: "ban", danger: true, onClick: () => setToggling(row) }
                        : { label: "Switch on", icon: "check-circle", onClick: () => setToggling(row) },
                    ]}
                  />
                </div>
              ),
            },
          ]}
          rows={data?.items || []}
          rowKey={(row) => row.id}
          loading={!data && !error}
          error={data ? "" : error}
          onRetry={load}
          empty={search.trim() || status ? "No restaurants match" : "No restaurants yet"}
          emptyIcon="store"
          emptyHint={search.trim() || status ? "Clear the search or the filter, or add a restaurant." : "Add the first restaurant with its owner's login."}
          rowClassName={(row) => (row.status === "active" ? "" : "dg-tone-muted")}
          // The API pages and searches; it does not sort, so the headers do
          // not offer to (sorting 25 of 300 would only look like an answer).
          server={{
            total: data?.total ?? 0,
            page: Math.floor(offset / limit) + 1,
            pageSize: limit,
            fetchAll,
            onChange: ({ page, pageSize }) => {
              setLimit(pageSize);
              setOffset((page - 1) * pageSize);
            },
          }}
          search={{
            value: search,
            placeholder: "Name or code",
            onChange: (value) => {
              setSearch(value);
              setOffset(0);
            },
          }}
          toolbar={
            <div className="field">
              <span>Show</span>
              <div className="segmented" role="radiogroup" aria-label="Which restaurants">
                {STATUS_VIEWS.map(([key, label]) => (
                  <button
                    key={key || "all"}
                    type="button"
                    role="radio"
                    aria-checked={status === key}
                    className={`segment ${status === key ? "is-active" : ""}`}
                    onClick={() => {
                      setStatus(key);
                      setOffset(0);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          }
          exportName="platform-restaurants"
        />
      </SectionCard>

      {adding && (
        <AddRestaurantModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            setOffset(0);
            load();
          }}
        />
      )}

      {toggling &&
        (toggling.status === "active" ? (
          <ConfirmDialog
            title={`Switch off ${toggling.name}`}
            message={`Switch off ${toggling.name}? Everyone who works there is signed out and told their restaurant is not active, until you switch it on again. Nothing is deleted.`}
            confirmLabel="Switch off"
            onConfirm={toggle}
            onCancel={() => setToggling(null)}
            busy={busy}
          />
        ) : (
          <Modal title={`Switch on ${toggling.name}`} icon="check-circle" onClose={() => setToggling(null)} width={440}>
            <div className="stack">
              <p>Its staff can sign in again straight away.</p>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={() => setToggling(null)}>
                  Cancel
                </button>
                <button type="button" className="button" onClick={toggle} disabled={busy}>
                  {busy ? "Switching on…" : "Switch on"}
                </button>
              </div>
            </div>
          </Modal>
        ))}

      {admins && <AdminsModal restaurant={admins.restaurant} onClose={() => setAdmins(null)} onDone={(message) => setSuccess(message)} />}
    </div>
  );
}

const EMPTY = {
  format: "restaurant",
  name: "",
  code: "",
  contact: "",
  email: "",
  address: "",
  invoicePrefix: "INV",
  orderPrefix: "ORD",
  adminName: "",
  adminEmail: "",
  adminMobile: "",
  adminPassword: "",
};

function AddRestaurantModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const change = (field) => (event) =>
    setForm({ ...form, [field]: field === "code" || field.endsWith("Prefix") ? event.target.value.toUpperCase() : event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const result = await createPlatformRestaurant({
        name: form.name,
        code: form.code,
        contact: form.contact || null,
        email: form.email || null,
        address: form.address || null,
        invoicePrefix: form.invoicePrefix || "INV",
        orderPrefix: form.orderPrefix || "ORD",
        format: form.format,
        admin: { name: form.adminName, email: form.adminEmail, mobile: form.adminMobile || null, password: form.adminPassword },
      });
      setDone(result);
      onCreated();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal title="Restaurant added" icon="check-circle" onClose={onClose} width={520}>
        <div className="stack">
          <div className="staff-done">
            <SuccessCheck size={48} label="Restaurant added" />
            <div>
              <strong>{done.message}</strong>
              <p className="muted small">
                It starts with {done.data.defaults.tax_rates} GST rates (5% restaurant service as the default), its settings,{" "}
                {done.data.defaults.channels} delivery channels and the kitchen display's station. The owner fills in
                the GSTIN and FSSAI number under Settings → GST and invoice after signing in.
              </p>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add a restaurant" description="The restaurant, and the owner's login (a Restaurant Admin). Everything a new restaurant needs is set up with it." icon="store" onClose={onClose} width={680}>
      <form className="form-grid" onSubmit={save}>
        <ErrorMessage message={error} />
        <p className="section-heading field-wide">The restaurant</p>
        <label className="field field-wide">
          <span>Format</span>
          <select value={form.format} onChange={change("format")}>
            <option value="restaurant">Restaurant: tables, captains, dine-in, takeaway and delivery</option>
            <option value="cafe">Café: order and pay at the counter, token numbers, a few tables</option>
            <option value="bakery">Bakery: bakes from recipes, by weight, cake pre-orders, day-end unsold</option>
            <option value="cloud_kitchen">Cloud kitchen: delivery only, Swiggy / Zomato channels, no tables</option>
          </select>
          <small className="muted">Sets how the POS opens and the features it starts with; the owner can change them later.</small>
        </label>
        <label className="field">
          <span>Name *</span>
          <input value={form.name} onChange={change("name")} required maxLength={150} autoFocus placeholder="Spice Route" />
        </label>
        <label className="field">
          <span>Code *</span>
          <input value={form.code} onChange={change("code")} required maxLength={30} placeholder="SPR001" className="mono" />
          <small className="muted">Staff type it with their staff code; letters and digits</small>
        </label>
        <label className="field">
          <span>Phone</span>
          <input value={form.contact} onChange={change("contact")} maxLength={20} inputMode="tel" />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={change("email")} />
        </label>
        <label className="field field-wide">
          <span>Address</span>
          <input value={form.address} onChange={change("address")} maxLength={500} />
        </label>
        <label className="field">
          <span>Bill number prefix</span>
          <input value={form.invoicePrefix} onChange={change("invoicePrefix")} maxLength={10} className="mono" />
        </label>
        <label className="field">
          <span>Order number prefix</span>
          <input value={form.orderPrefix} onChange={change("orderPrefix")} maxLength={10} className="mono" />
        </label>
        <p className="section-heading field-wide">The owner's login</p>
        <label className="field">
          <span>Full name *</span>
          <input value={form.adminName} onChange={change("adminName")} required maxLength={150} />
        </label>
        <label className="field">
          <span>Email *</span>
          <input type="email" value={form.adminEmail} onChange={change("adminEmail")} required />
        </label>
        <label className="field">
          <span>Mobile</span>
          <input value={form.adminMobile} onChange={change("adminMobile")} maxLength={20} inputMode="tel" />
        </label>
        <label className="field">
          <span>Password *</span>
          <input type="password" value={form.adminPassword} onChange={change("adminPassword")} required minLength={8} maxLength={72} autoComplete="new-password" />
          <small className="muted">At least 8 characters; they choose their own when they first sign in</small>
        </label>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Setting it up…" : "Add restaurant"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AdminsModal({ restaurant, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listPlatformAdmins(restaurant.id)
      .then(setData)
      .catch((err) => setError(getErrorMessage(err)));
  }, [restaurant.id]);

  const reset = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const result = await resetPlatformAdminPassword(restaurant.id, resetting.id, password);
      onDone(result.message);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Admins — ${restaurant.name}`}
      description="The people who run this restaurant's logins. Give one a new password when they are locked out of their own restaurant."
      icon="key"
      onClose={onClose}
      width={560}
    >
      <ErrorMessage message={error} />
      {!data ? (
        error ? null : <Loading />
      ) : data.admins.length === 0 ? (
        <EmptyState icon="users" message="No admin found" hint="This restaurant has nobody who manages users and roles." />
      ) : resetting ? (
        <form className="form-grid" onSubmit={reset}>
          <p className="field-wide">
            A new password for <strong>{resetting.name}</strong> ({resetting.email || resetting.mobile}). They are signed out
            everywhere and any lockout is lifted. Tell them the password; they choose their own at their next sign-in.
          </p>
          <label className="field field-wide">
            <span>New password *</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={72} autoFocus autoComplete="new-password" />
          </label>
          <div className="form-actions field-wide">
            <button type="button" className="button button-secondary" onClick={() => setResetting(null)}>
              Back
            </button>
            <button type="submit" className="button" disabled={busy || password.length < 8}>
              {busy ? "Saving…" : "Set new password"}
            </button>
          </div>
        </form>
      ) : (
        <ul className="staff-share-rows">
          {data.admins.map((admin) => (
            <li key={admin.id}>
              <span>
                <strong>{admin.name}</strong>
                <small className="muted">
                  {admin.email || admin.mobile} · {admin.status === "active" ? "active" : admin.status}
                  {admin.locked ? " · locked out now" : ""} · last sign-in {lastSeen(admin.lastLoginAt)}
                </small>
              </span>
              <button type="button" className="chip-button" onClick={() => setResetting(admin)}>
                <Icon name="lock" size={14} /> New password
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
