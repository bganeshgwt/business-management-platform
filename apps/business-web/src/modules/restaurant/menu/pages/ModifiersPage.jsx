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
  createModifier,
  deleteModifier,
  listModifiers,
  updateModifier,
} from "../services/menu.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import ModifierRecipeModal from "./ModifierRecipeModal";
import "../../../../styles/menu.css";

const EMPTY = { name: "", price: 0, status: "active", kitchenName: "" };

export default function ModifiersPage() {
  const { hasPermission, hasFeature } = useAuth();
  const canManage = hasPermission("menu.manage");
  const recipesOn = hasFeature("stock_recipes");

  const [modifiers, setModifiers] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // An add-on that has been sold cannot be deleted (past bills name it); the
  // server says so and it is switched off instead, in one click.
  const [switchOffer, setSwitchOffer] = useState(null);
  const [recipeFor, setRecipeFor] = useState(null);

  const load = useCallback(
    () =>
      listModifiers()
        .then(setModifiers)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, [load]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const openNew = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const openEdit = (modifier) => {
    setForm({
      name: modifier.name,
      price: modifier.price,
      status: modifier.status,
      kitchenName: modifier.kitchenName || "",
    });
    setFormError("");
    setEditing(modifier);
  };

  // An edit sends only the fields that were changed in the form, so an
  // add-on's price changed elsewhere meanwhile (an import) is not put back.
  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      ...form,
      name: form.name.trim(),
      price: Number(form.price),
      kitchenName: (form.kitchenName || "").trim() || null,
    };

    try {
      if (editing.id) {
        const changed = Object.fromEntries(
          ["name", "price", "status", "kitchenName"]
            .filter(
              (key) =>
                payload[key] !==
                (key === "price" ? Number(editing.price) : key === "kitchenName" ? editing.kitchenName || null : editing[key])
            )
            .map((key) => [key, payload[key]])
        );

        if (Object.keys(changed).length > 0) {
          await updateModifier(editing.id, changed);
        }

        setSuccess(Object.keys(changed).length > 0 ? "Modifier updated" : `Nothing changed on "${editing.name}"`);
      } else {
        await createModifier(payload);
        setSuccess("Modifier created");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteModifier(deleting.id);
      setDeleting(null);
      setSuccess(`"${deleting.name}" deleted`);
      load();
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.canArchive) {
        setSwitchOffer({ modifier: deleting, message: response.message });
      } else {
        setError(getErrorMessage(err));
      }

      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (modifier, status) => {
    setError("");

    try {
      // Only the status: the price on this screen may be older than the add-on's.
      await updateModifier(modifier.id, { status });
      setSuccess(status === "active" ? `"${modifier.name}" is offered again` : `"${modifier.name}" switched off`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const offered = modifiers.filter((modifier) => modifier.status === "active");
  // Offered, but no dish lists it: nobody at the till or on the QR menu ever sees it.
  const unattached = offered.filter((modifier) => Number(modifier.productCount) === 0).length;

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="plus" size={16} /> Add modifier
    </button>
  );

  return (
    <div className="stack mnu-page">
      <PageHeader
        icon="sliders"
        title="Modifiers"
        description="The add-ons a guest can choose with a dish, like Extra cheese, and what each one costs."
        action={addButton}
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && modifiers.length > 0 && (
        <div className="stat-grid mnu-tiles">
          <StatTile icon="check-circle" tone="success" label="Offered" value={count(offered.length)} note="can be added to a dish" />
          <StatTile
            icon="ban"
            tone="neutral"
            label="Switched off"
            value={count(modifiers.length - offered.length)}
            note="not offered on any dish"
          />
          <StatTile
            icon="alert"
            tone={unattached > 0 ? "warning" : "neutral"}
            label="On no dish yet"
            value={count(unattached)}
            note="offered, but no dish lists it"
          />
        </div>
      )}

      <SectionCard
        icon="list"
        title="All modifiers"
        description="Tick them for a dish under Products → ⋯ → Sizes & add-ons. Switching one off stops it on every dish at once; one that has been sold can’t be deleted, only switched off."
        className="mnu-list"
        flush
      >
        <DataGrid
          id="menu-modifiers"
          caption="Modifiers"
          columns={[
            {
              key: "name",
              header: "Name",
              value: (modifier) => modifier.name,
              mobile: "title",
              pin: true,
              filter: "text",
              render: (modifier) => (
                <>
                  {modifier.name}
                  {modifier.kitchenName && (
                    <div className="muted small" title="Kitchen name: printed on KOTs">
                      KOT: {modifier.kitchenName}
                    </div>
                  )}
                </>
              ),
            },
            { key: "kitchenName", header: "Kitchen name", value: (modifier) => modifier.kitchenName, defaultHidden: true },
            {
              key: "price",
              header: "Extra charge",
              type: "money",
              value: (modifier) => Number(modifier.price),
              mobile: "show",
              render: (modifier) =>
                Number(modifier.price) === 0 ? <span className="muted">Free</span> : `+${money(modifier.price, currency)}`,
            },
            {
              key: "dishes",
              header: "Offered on",
              type: "number",
              value: (modifier) => Number(modifier.productCount || 0),
              mobile: "show",
              render: (modifier) => (
                <span className="nowrap">
                  {modifier.productCount}
                  <span className="muted"> {modifier.productCount === 1 ? "dish" : "dishes"}</span>
                </span>
              ),
            },
            {
              key: "sold",
              header: "Sold",
              type: "number",
              value: (modifier) => Number(modifier.timesSold || 0),
              mobile: "show",
              render: (modifier) =>
                modifier.timesSold > 0 ? (
                  <span className="nowrap">
                    {modifier.timesSold}
                    <span className="muted"> {modifier.timesSold === 1 ? "time" : "times"}</span>
                  </span>
                ) : (
                  <span className="muted">never</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (modifier) => modifier.status,
              filter: "select",
              filterOptions: [
                { value: "active", label: "Offered" },
                { value: "inactive", label: "Switched off" },
              ],
              csv: (modifier) => (modifier.status === "active" ? "Offered" : "Switched off"),
              mobile: "subtitle",
              render: (modifier) => (
                <span className={`badge status-badge ${modifier.status === "active" ? "badge-active" : "badge-neutral"}`}>
                  <span className="badge-dot" aria-hidden="true" />
                  {modifier.status === "active" ? "Offered" : "Switched off"}
                </span>
              ),
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (modifier) => (
                <div className="row-actions">
                  <button type="button" className="chip-button" onClick={() => openEdit(modifier)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <ActionMenu
                    label={`More actions for ${modifier.name}`}
                    items={[
                      ...(recipesOn ? [{ label: "Ingredient recipe", icon: "book", onClick: () => setRecipeFor(modifier) }] : []),
                      modifier.status === "active"
                        ? { label: "Switch off", icon: "ban", onClick: () => setStatus(modifier, "inactive") }
                        : { label: "Switch on", icon: "check-circle", onClick: () => setStatus(modifier, "active") },
                      ...(modifier.timesSold === 0
                        ? [
                            { separator: true },
                            { label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(modifier) },
                          ]
                        : []),
                    ]}
                  />
                </div>
              ),
            },
          ]}
          rows={modifiers}
          rowKey={(modifier) => modifier.id}
          loading={loading}
          empty="No modifiers yet"
          emptyIcon="sliders"
          emptyHint="Add the extras your kitchen offers, like Extra cheese or Less spicy, then attach them to dishes from the Products page."
          emptyAction={addButton}
          rowClassName={(modifier) => (modifier.status === "active" ? "" : "dg-tone-muted")}
          currency={currency}
          rowNoun={["modifier", "modifiers"]}
          search="Modifier name"
          exportName="menu-modifiers"
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit modifier" : "Add modifier"}
          description="An add-on a guest can choose with a dish, and what it adds to the bill."
          icon={editing.id ? "edit" : "plus"}
          onClose={() => setEditing(null)}
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
                maxLength={100}
                placeholder="Extra cheese"
              />
            </label>

            <label className="field">
              <span>Extra charge ({currency})</span>
              <input type="number" min="0" step="0.01" value={form.price} onChange={change("price")} />
              <small className="muted">0 for a free choice, like Less spicy</small>
            </label>

            {/* The add-on's name on the KOT, in the cooks' script. */}
            <label className="field field-wide">
              <span>Kitchen name</span>
              <input
                value={form.kitchenName}
                onChange={change("kitchenName")}
                maxLength={100}
                placeholder="e.g. एक्स्ट्रा चीज़"
              />
              <small className="muted">
                Optional, in any language. Printed on KOTs on every dish that offers it; the bill keeps the name.
              </small>
            </label>

            <label className="field field-wide">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Offered</option>
                <option value="inactive">Switched off (not offered on any dish)</option>
              </select>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {recipeFor && <ModifierRecipeModal modifier={recipeFor} onClose={() => setRecipeFor(null)} />}

      {deleting && (
        <ConfirmDialog
          title="Delete modifier"
          message={`Delete "${deleting.name}"? It will be removed from ${deleting.productCount} ${
            deleting.productCount === 1 ? "dish" : "dishes"
          }.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}

      {switchOffer && (
        <Modal title="Switch it off instead?" icon="ban" onClose={() => setSwitchOffer(null)} width={480}>
          <p>{switchOffer.message}</p>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setSwitchOffer(null)}>
              Keep offering it
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                const { modifier } = switchOffer;
                setSwitchOffer(null);
                setStatus(modifier, "inactive");
              }}
            >
              Switch “{switchOffer.modifier.name}” off
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
