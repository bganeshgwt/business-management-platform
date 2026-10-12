import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatusBadge from "../../../../components/StatusBadge";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createTaxRate,
  deleteTaxRate,
  listTaxRates,
  updateTaxRate,
} from "../services/menu.service";
import { getErrorMessage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import "../../../../styles/billing.css";

const EMPTY = {
  name: "",
  percentage: "",
  hsnCode: "",
  cessPercentage: "0",
  isDefault: false,
  status: "active",
  moveProductsTo: "",
};

export default function TaxRatesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("menu.manage");

  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  // The dishes still on a rate being switched off, as the server listed them.
  const [inUse, setInUse] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(
    () =>
      listTaxRates()
        .then(setRates)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const startAdd = () => {
    setForm(EMPTY);
    setFormError("");
    setInUse(null);
    setEditing({});
  };

  const startEdit = (rate, overrides = {}) => {
    setForm({
      name: rate.name,
      percentage: String(rate.percentage),
      hsnCode: rate.hsnCode || "",
      cessPercentage: String(rate.cessPercentage),
      isDefault: rate.isDefault,
      status: rate.status,
      moveProductsTo: "",
      ...overrides,
    });
    setFormError("");
    setInUse(null);
    setEditing(rate);
  };

  // Where the dishes of a rate being switched off can go: any other rate that
  // is on.
  const targets = editing ? rates.filter((rate) => rate.id !== editing.id && rate.status === "active") : [];
  const dishesOnIt = editing && editing.id ? editing.productCount : 0;
  const switchingOff = Boolean(editing && editing.id && form.status === "inactive" && dishesOnIt > 0);

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      name: form.name,
      percentage: Number(form.percentage || 0),
      hsnCode: form.hsnCode || null,
      cessPercentage: Number(form.cessPercentage || 0),
      isDefault: form.isDefault,
      status: form.status,
      moveProductsTo: switchingOff && form.moveProductsTo ? Number(form.moveProductsTo) : null,
    };

    try {
      const result = editing.id
        ? await updateTaxRate(editing.id, payload)
        : await createTaxRate(payload);

      setEditing(null);
      setSuccess(result.message);
      load();
    } catch (err) {
      const details = err.response && err.response.data && err.response.data.data;

      if (details && details.reason === "rate_in_use") {
        setInUse(details);
      }

      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteTaxRate(deleting.id);
      setDeleting(null);
      setSuccess("Tax rate deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  // A rate switched off before this rule, with dishes still on it: they are
  // still being charged at it, which the list says, with the way out.
  const stranded = rates.filter((rate) => rate.status === "inactive" && rate.productCount > 0);
  const strandedDishes = stranded.reduce((sum, rate) => sum + rate.productCount, 0);
  const ratesOn = rates.filter((rate) => rate.status === "active").length;
  const defaultRate = rates.find((rate) => rate.isDefault);
  const dishesCharged = rates.reduce((sum, rate) => sum + (rate.status === "active" ? rate.productCount : 0), 0);

  return (
    <div className="stack">
      <PageHeader
        icon="percent"
        title="Tax rates"
        description="The GST rates and HSN/SAC codes your dishes are charged at, printed on every tax invoice"
        action={
          canManage && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setForm(EMPTY);
                setFormError("");
                setInUse(null);
                setEditing({});
              }}
            >
              <Icon name="plus" size={16} /> Add rate
            </button>
          )
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {strandedDishes > 0 && (
        <div className="alert alert-notice">
          {stranded.map((rate) => rate.name).join(", ")} {stranded.length === 1 ? "is" : "are"} switched off but still on{" "}
          {strandedDishes} {strandedDishes === 1 ? "dish, which keeps" : "dishes, which keep"} selling at{" "}
          {stranded.length === 1 ? "it" : "them"}. Use “Move dishes” to put {strandedDishes === 1 ? "it" : "them"} on a rate
          that is on.
        </div>
      )}

      {!loading && rates.length > 0 && (
        <div className="stat-grid">
          <StatTile
            icon="check-circle"
            tone="success"
            label="Rates on"
            value={String(ratesOn)}
            of={` of ${rates.length}`}
            note={`${dishesCharged} dish${dishesCharged === 1 ? "" : "es"} charged at them`}
          />
          <StatTile
            icon="star"
            tone="primary"
            label="Default for new dishes"
            value={defaultRate ? `${defaultRate.percentage}%` : "None"}
            note={defaultRate ? defaultRate.name : "Pick one when adding a rate"}
          />
          <StatTile
            icon="alert"
            tone={strandedDishes > 0 ? "warning" : "neutral"}
            label="On switched-off rates"
            value={String(strandedDishes)}
            note={strandedDishes > 0 ? "Dishes to move to a rate that is on" : "Every dish is on a rate that is on"}
          />
        </div>
      )}

      <SectionCard
        icon="list"
        title="Rates"
        description="Changing a rate re-prices every dish on it; bills already raised keep what they charged. A rate that is off is charged on nothing new, so its dishes move to another rate when it is switched off."
        flush
      >
        <DataGrid
          id="tax-rates"
          caption="Tax rates"
          rows={rates}
          rowKey={(rate) => rate.id}
          loading={loading}
          rowNoun={["rate", "rates"]}
          empty="No tax rates yet."
          emptyHint="Add GST 5% (SAC 996331) for restaurant service to start."
          emptyIcon="percent"
          emptyAction={
            canManage && (
              <button type="button" className="button button-secondary" onClick={startAdd}>
                <Icon name="plus" size={16} /> Add rate
              </button>
            )
          }
          rowClassName={(rate) =>
            rate.status === "inactive" && rate.productCount > 0 ? "dg-tone-warning" : rate.status === "inactive" ? "dg-tone-muted" : ""
          }
          exportName="tax-rates"
          columns={[
            {
              key: "name",
              header: "Name",
              value: (rate) => rate.name,
              mobile: "title",
              pin: true,
              render: (rate) => (
                <span className="rate-name">
                  <strong>{rate.name}</strong>
                  {rate.isDefault && (
                    <span className="badge badge-primary">
                      <Icon name="star" size={12} /> Default
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "rate",
              header: "Rate",
              type: "percent",
              value: (rate) => rate.percentage,
              mobile: "show",
              render: (rate) => <span className="rate-pill">{rate.percentage}%</span>,
            },
            { key: "cess", header: "Cess", type: "percent", value: (rate) => rate.cessPercentage || null, mobile: "show" },
            {
              key: "hsn",
              header: "HSN / SAC",
              value: (rate) => rate.hsnCode,
              mobile: "show",
              render: (rate) => (rate.hsnCode ? <span className="mono">{rate.hsnCode}</span> : <span className="muted">—</span>),
            },
            { key: "dishes", header: "Dishes", type: "number", value: (rate) => rate.productCount, total: "sum", mobile: "show" },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (rate) => rate.status,
              filter: "select",
              mobile: "subtitle",
              render: (rate) => (
                <>
                  <StatusBadge status={rate.status} />
                  {rate.status === "inactive" && rate.productCount > 0 && (
                    <span className="rate-warning">
                      <Icon name="alert" size={13} /> still charged on {rate.productCount}
                    </span>
                  )}
                </>
              ),
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (rate) => (
                <div className="row-actions">
                  {rate.status === "inactive" && rate.productCount > 0 ? (
                    <button type="button" className="link-button" onClick={() => startEdit(rate, { status: "inactive" })}>
                      Move dishes
                    </button>
                  ) : (
                    <button type="button" className="link-button" onClick={() => startEdit(rate)}>
                      Edit
                    </button>
                  )}
                  {/* Delete sits behind the menu, away from Edit. A rate
                      dishes still use cannot be deleted, and says why. */}
                  <ActionMenu
                    label={`More actions for ${rate.name}`}
                    items={[
                      {
                        label: rate.productCount > 0 ? "Delete — dishes use it" : "Delete",
                        icon: "trash",
                        danger: true,
                        disabled: rate.productCount > 0,
                        onClick: () => setDeleting(rate),
                      },
                    ]}
                  />
                </div>
              ),
            },
          ]}
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit tax rate" : "Add tax rate"}
          icon="percent"
          description={
            editing.id
              ? "A new rate re-prices every dish on it from the next sale. Bills already raised keep what they charged."
              : "Put dishes on it from the menu, or make it the default for new dishes."
          }
          onClose={() => setEditing(null)}
          width={600}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Name *</span>
              <input
                value={form.name}
                onChange={change("name")}
                required
                autoFocus
                maxLength={80}
                placeholder="GST 5% (restaurant)"
              />
            </label>

            <label className="field">
              <span>Rate % *</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.percentage}
                onChange={change("percentage")}
                required
              />
              <small className="muted">Split half and half into CGST and SGST on the bill</small>
            </label>

            <label className="field">
              <span>HSN / SAC code</span>
              <input
                value={form.hsnCode}
                onChange={change("hsnCode")}
                maxLength={10}
                placeholder="996331"
              />
              <small className="muted">Restaurant service is SAC 996331</small>
            </label>

            <label className="field">
              <span>Cess %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.cessPercentage}
                onChange={change("cessPercentage")}
              />
              <small className="muted">Charged on the bill on top of GST, on its own line. Leave 0 for restaurant food.</small>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")} disabled={form.isDefault}>
                <option value="active">On — charged on dishes</option>
                <option value="inactive">Off — charged on nothing new</option>
              </select>
              {form.isDefault && <small className="muted">The default rate stays on</small>}
            </label>

            <label className="checkbox field-wide">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(event) =>
                  setForm({ ...form, isDefault: event.target.checked, status: event.target.checked ? "active" : form.status })
                }
              />
              <span>Use this rate for new dishes</span>
            </label>

            {switchingOff && (
              <div className="field-wide move-dishes">
                <div className="alert alert-notice">
                  {dishesOnIt} dish{dishesOnIt === 1 ? " is" : "es are"} on this rate. A rate that is off is not charged on
                  new sales, so they move to another rate as it switches off.
                </div>
                {inUse && inUse.dishes && (
                  <ul aria-label="Dishes on this rate">
                    {inUse.dishes.map((dish) => (
                      <li key={dish.id}>{dish.name}</li>
                    ))}
                    {inUse.dishCount > inUse.dishes.length && <li>and {inUse.dishCount - inUse.dishes.length} more</li>}
                  </ul>
                )}
                <label className="field">
                  <span>Move its dishes to *</span>
                  <select value={form.moveProductsTo} onChange={change("moveProductsTo")} required>
                    <option value="">Choose a rate…</option>
                    {targets.map((rate) => (
                      <option key={rate.id} value={rate.id}>
                        {rate.name} ({rate.percentage}%{rate.cessPercentage ? ` + ${rate.cessPercentage}% cess` : ""})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="form-actions field-wide">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving || (switchingOff && !form.moveProductsTo)}>
                {saving ? "Saving…" : switchingOff ? "Move dishes and switch off" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete tax rate"
          message={`Delete "${deleting.name}"?`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
