import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createPriceWindow,
  deletePriceWindow,
  listPriceWindows,
  updatePriceWindow,
} from "../services/priceWindow.service";
import { listOutlets } from "../../../../services/outlet.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import PriceWindowItemsModal from "./PriceWindowItemsModal";
import "../../../../styles/menu.css";

// Sunday is 0, matching what PostgreSQL returns for the day of the week.
const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

// The week as a restaurant reads its rota: Monday first, Sunday last.
const WEEK = [1, 2, 3, 4, 5, 6, 0].map((value) => DAYS.find((day) => day.value === value));

const EMPTY = {
  name: "",
  // Empty means every outlet.
  outletId: "",
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: "16:00",
  endTime: "19:00",
  validFrom: "",
  validTo: "",
  priority: 0,
  status: "active",
};

const describeDays = (days) => {
  if (!days || days.length === 7) {
    return "Every day";
  }

  return DAYS.filter((day) => days.includes(day.value))
    .map((day) => day.label)
    .join(", ");
};

// Seven small letters, the days the window runs lit up: the week reads at a
// glance down a long list. The words are there for a screen reader.
function WeekStrip({ days }) {
  const on = days || [0, 1, 2, 3, 4, 5, 6];

  return (
    <span className="mnu-week" title={describeDays(days)}>
      {WEEK.map((day) => (
        <span key={day.value} className={`mnu-week-day${on.includes(day.value) ? " is-on" : ""}`} aria-hidden="true">
          {day.label.charAt(0)}
        </span>
      ))}
      <span className="sr-only">{describeDays(days)}</span>
    </span>
  );
}

const HOW_IT_WORKS = [
  { icon: "tag", text: "A window replaces the menu price while it is open; the menu price comes back by itself when it closes." },
  { icon: "layers", text: "Each size of a dish has its own window price, so a Half plate is never dearer than it is outside the window." },
  { icon: "moon", text: "An end time earlier than the start means the window runs past midnight." },
  { icon: "arrow-up", text: "When two windows cover the same dish, the one with the higher priority wins." },
];

export default function PriceWindowsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("menu.manage");
  // The outlet list only feeds the add/edit form's Where field. A captain has
  // neither the form nor outlets.view, and asking anyway was refused (403).
  const canPickOutlet = canManage && hasPermission("outlets.view");

  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [pricingFor, setPricingFor] = useState(null);
  // Only offered when the restaurant runs more than one place. A window tied
  // to an outlet applies there and nowhere else.
  const [outlets, setOutlets] = useState([]);

  const load = useCallback(
    () =>
      listPriceWindows()
        .then(setWindows)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canPickOutlet) {
      return;
    }

    listOutlets()
      .then((rows) => setOutlets(rows))
      .catch(() => setOutlets([]));
  }, [canPickOutlet]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const toggleDay = (value) =>
    setForm({
      ...form,
      daysOfWeek: form.daysOfWeek.includes(value)
        ? form.daysOfWeek.filter((day) => day !== value)
        : [...form.daysOfWeek, value].sort(),
    });

  const save = async (event) => {
    event.preventDefault();
    setFormError("");

    if (form.daysOfWeek.length === 0) {
      setFormError("Choose at least one day of the week");
      return;
    }

    setSaving(true);

    const payload = {
      name: form.name,
      // Sent back even when the outlet list could not be read, so saving the
      // hours never quietly turns an outlet-only window into an every-outlet one.
      outletId: form.outletId ? Number(form.outletId) : null,
      daysOfWeek: form.daysOfWeek,
      startTime: form.startTime,
      endTime: form.endTime,
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
      priority: Number(form.priority || 0),
      status: form.status,
    };

    try {
      if (editing.id) {
        await updatePriceWindow(editing.id, payload);
        setSuccess("Price window saved");
      } else {
        await createPriceWindow(payload);
        setSuccess("Price window added");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openNew = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const startEdit = (row) => {
    setForm({
      name: row.name,
      outletId: row.outletId ? String(row.outletId) : "",
      daysOfWeek: row.daysOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      validFrom: row.validFrom || "",
      validTo: row.validTo || "",
      priority: row.priority,
      status: row.status,
    });
    setFormError("");
    setEditing(row);
  };

  // The same actions on a wide screen's table and a phone's card: the prices
  // (the everyday job) in reach; changing the hours, and Delete, behind the menu.
  const actionsFor = (row) => (
    <div className="row-actions">
      <button type="button" className="chip-button" onClick={() => setPricingFor(row)}>
        <Icon name="tag" size={14} /> Dishes &amp; prices
      </button>
      {canManage && (
        <ActionMenu
          label={`More actions for ${row.name}`}
          items={[
            { label: "Edit days and hours", icon: "edit", onClick: () => startEdit(row) },
            { separator: true },
            { label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(row) },
          ]}
        />
      )}
    </div>
  );

  const seasonOf = (row) =>
    row.validFrom || row.validTo ? `${row.validFrom || "any"} → ${row.validTo || "any"}` : "Always";

  const hoursOf = (row) => (
    <span className="mnu-hours">
      <Icon name="clock" size={14} className="mnu-hours-icon" />
      <span className="mono">
        {row.startTime}–{row.endTime}
      </span>
      {row.endTime <= row.startTime && (
        <span className="badge badge-neutral mnu-midnight">
          <Icon name="moon" size={12} /> past midnight
        </span>
      )}
    </span>
  );

  const whereOf = (row) =>
    row.outletName ? (
      <span className="badge badge-primary mnu-outlet">
        <Icon name="map-pin" size={12} /> {row.outletName} only
      </span>
    ) : (
      <span className="muted">Every outlet</span>
    );

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deletePriceWindow(deleting.id);
      setDeleting(null);
      setSuccess("Price window deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const active = windows.filter((row) => row.status === "active");
  // The windows that can open come first; switched-off ones follow, each
  // group in the server's order.
  const ordered = [...active, ...windows.filter((row) => row.status !== "active")];

  // Switched off is a choice, not a fault: grey, in the tile's own words.
  const statusOf = (row) => (
    <span className={`badge status-badge ${row.status === "active" ? "badge-active" : "badge-neutral"}`}>
      <span className="badge-dot" aria-hidden="true" />
      {row.status === "active" ? "Active" : "Switched off"}
    </span>
  );
  const dishesCovered = active.reduce((sum, row) => sum + Number(row.itemCount || 0), 0);

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="plus" size={16} /> Add window
    </button>
  );

  return (
    <div className="stack mnu-page">
      <PageHeader
        icon="timer"
        title="Happy hour"
        description="Dishes sold at a different price at set times, like an evening happy hour."
        action={addButton}
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && windows.length > 0 && (
        <div className="stat-grid mnu-tiles">
          <StatTile icon="timer" tone="primary" label="Active windows" value={count(active.length)} note="run on their days and hours" />
          <StatTile
            icon="ban"
            tone="neutral"
            label="Switched off"
            value={count(windows.length - active.length)}
            note="kept, but never open"
          />
          <StatTile icon="tag" tone="success" label="Dishes on offer" value={count(dishesCovered)} note="summed across active windows" />
        </div>
      )}

      <SectionCard
        icon="info"
        tone="info"
        title="How price windows work"
        className="mnu-how-card"
        bodyClassName="mnu-how-body"
      >
        <ul className="mnu-how">
          {HOW_IT_WORKS.map((point) => (
            <li key={point.icon}>
              <span className="mnu-how-icon" aria-hidden="true">
                <Icon name={point.icon} size={16} />
              </span>
              <span>{point.text}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        icon="list"
        title="Price windows"
        description="Dishes & prices sets what each dish sells for while the window is open."
        className="mnu-list"
        flush
      >
        {/* One grid for every width: on a phone each window becomes a card. */}
        <DataGrid
          id="menu-price-windows"
          caption="Price windows"
          columns={[
            {
              key: "name",
              header: "Name",
              value: (row) => row.name,
              mobile: "title",
              pin: true,
              filter: "text",
              width: 170,
              render: (row) => (
                <>
                  <span className="mnu-dish">{row.name}</span>
                  <span className="mnu-hh-where small">{whereOf(row)}</span>
                </>
              ),
            },
            {
              key: "where",
              header: "Where",
              value: (row) => row.outletName || "Every outlet",
              filter: "select",
              defaultHidden: true,
            },
            {
              key: "days",
              header: "Days",
              width: 190,
              value: (row) => describeDays(row.daysOfWeek),
              mobile: "show",
              render: (row) => <WeekStrip days={row.daysOfWeek} />,
            },
            {
              key: "hours",
              header: "Hours",
              width: 150,
              value: (row) => `${row.startTime}–${row.endTime}`,
              mobile: "show",
              render: (row) => <span className="small nowrap">{hoursOf(row)}</span>,
            },
            {
              key: "season",
              header: "Season",
              // Nearly always "Always", so it waits in the Columns menu.
              defaultHidden: true,
              width: 140,
              value: (row) => seasonOf(row),
              mobile: "show",
              render: (row) => (
                <span className={`small nowrap${row.validFrom || row.validTo ? "" : " muted"}`}>{seasonOf(row)}</span>
              ),
            },
            { key: "priority", header: "Priority", type: "number", width: 120, value: (row) => Number(row.priority || 0) },
            { key: "dishes", header: "Dishes", type: "number", width: 120, value: (row) => Number(row.itemCount || 0), mobile: "show" },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (row) => row.status,
              filter: "select",
              filterOptions: [
                { value: "active", label: "Active" },
                { value: "inactive", label: "Switched off" },
              ],
              csv: (row) => (row.status === "active" ? "Active" : "Switched off"),
              mobile: "subtitle",
              width: 120,
              render: (row) => statusOf(row),
            },
            { key: "actions", header: "", label: "Actions", type: "actions", render: (row) => actionsFor(row) },
          ]}
          rows={ordered}
          rowKey={(row) => row.id}
          loading={loading}
          empty="No timed prices yet"
          emptyIcon="timer"
          emptyHint="Add a window — say Mon to Fri, 4 pm to 7 pm — then choose the dishes and what they sell for while it is open."
          emptyAction={addButton}
          rowClassName={(row) => (row.status === "active" ? "" : "dg-tone-muted")}
          rowNoun={["window", "windows"]}
          search="Window name"
          exportName="price-windows"
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit price window" : "Add price window"}
          description="When it is open. Its dishes and prices are set under Dishes & prices."
          icon={editing.id ? "edit" : "timer"}
          onClose={() => setEditing(null)}
          width={640}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <label className="field field-wide">
              <span>Name *</span>
              <input
                value={form.name}
                onChange={change("name")}
                required
                autoFocus
                maxLength={80}
                placeholder="Happy hour"
              />
            </label>

            {(outlets.length > 1 || form.outletId) && (
              <label className="field field-wide">
                <span>Where</span>
                <select value={form.outletId} onChange={change("outletId")}>
                  <option value="">Every outlet</option>
                  {outlets.map((outlet) => (
                    <option key={outlet.id} value={outlet.id}>
                      {outlet.name} only
                    </option>
                  ))}
                  {form.outletId && !outlets.some((outlet) => String(outlet.id) === String(form.outletId)) && (
                    <option value={form.outletId}>This window's outlet</option>
                  )}
                </select>
                <small className="muted">
                  An outlet's own happy hour is charged at that outlet only.
                </small>
              </label>
            )}

            <p className="section-heading field-wide">When it is open</p>

            <fieldset className="field field-wide mnu-days-field">
              <legend>Days *</legend>
              <div className="mnu-days">
                {WEEK.map((day) => (
                  <label key={day.value} className="mnu-day">
                    <input
                      type="checkbox"
                      checked={form.daysOfWeek.includes(day.value)}
                      onChange={() => toggleDay(day.value)}
                    />
                    <span>{day.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="field">
              <span>From *</span>
              <input type="time" value={form.startTime} onChange={change("startTime")} required />
            </label>

            <label className="field">
              <span>To *</span>
              <input type="time" value={form.endTime} onChange={change("endTime")} required />
              <small className="muted">Earlier than the start means it runs past midnight</small>
            </label>

            <label className="field">
              <span>Season starts</span>
              <input type="date" value={form.validFrom} onChange={change("validFrom")} />
            </label>

            <label className="field">
              <span>Season ends</span>
              <input type="date" value={form.validTo} onChange={change("validTo")} />
              <small className="muted">Leave both blank to run all year</small>
            </label>

            <p className="section-heading field-wide">Rules</p>

            <label className="field">
              <span>Priority</span>
              <input
                type="number"
                min="0"
                max="999"
                value={form.priority}
                onChange={change("priority")}
              />
              <small className="muted">Higher wins when two windows overlap</small>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Switched off (kept, never opens)</option>
              </select>
            </label>

            <div className="form-actions field-wide">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {pricingFor && (
        <PriceWindowItemsModal
          window={pricingFor}
          canManage={canManage}
          onClose={() => setPricingFor(null)}
          onSaved={(message) => {
            setPricingFor(null);
            setSuccess(message);
            load();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete price window"
          message={`Delete "${deleting.name}"? Dishes go back to their normal price.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
