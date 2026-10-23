import { useCallback, useEffect, useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createPaymentType,
  deletePaymentType,
  listPaymentTypes,
  updatePaymentType,
} from "../services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { BILL_PAYMENT_OPTIONS, paymentMethodLabel } from "../../../../services/labels";

// Owner-named payment types: a Pluxee or Sodexo meal card or
// a cheque under Other, PhonePe under UPI. The till offers them under their
// method; the day summary and the reports total each one apart. A type that
// was used is switched off, never deleted, so history keeps its name.
// Saved on its own, apart from the settings form above it.

const EMPTY = { id: null, paymentMethod: "other", name: "", needsReference: false };

export default function PaymentTypesCard({ canEdit }) {
  const [types, setTypes] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    listPaymentTypes()
      .then((rows) => {
        setTypes(rows);
        setLoadError("");
      })
      .catch((err) => setLoadError(getErrorMessage(err)));
  }, [reload]);

  const act = useCallback(async (work) => {
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const result = await work();
      setNotice(result && result.message ? result.message : "Saved");
      setReload((count) => count + 1);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const save = (event) => {
    event.preventDefault();
    const payload = { name: draft.name.trim(), needsReference: draft.needsReference };

    act(() =>
      draft.id
        ? updatePaymentType(draft.id, { ...payload, status: draft.status || "active", sortOrder: draft.sortOrder || 0 })
        : createPaymentType({ ...payload, paymentMethod: draft.paymentMethod })
    ).then((done) => done && setDraft(EMPTY));
  };

  const columns = [
    {
      key: "method",
      header: "Under",
      value: (row) => row.paymentMethod,
      render: (row) => paymentMethodLabel(row.paymentMethod),
      filter: "select",
      filterOptions: BILL_PAYMENT_OPTIONS,
      mobile: "subtitle",
    },
    { key: "name", header: "Payment type", value: (row) => row.name, mobile: "title" },
    {
      key: "reference",
      header: "Reference",
      value: (row) => (row.needsReference ? "Needed" : "Optional"),
      mobile: "show",
    },
    { key: "used", header: "Payments", type: "number", value: (row) => row.usedCount || 0, mobile: "show" },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (row) => row.status,
      render: (row) => (
        <span className={`badge ${row.status === "active" ? "badge-active" : "badge-inactive"}`}>
          {row.status === "active" ? "In use" : "Switched off"}
        </span>
      ),
      mobile: "show",
    },
    canEdit && {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => (
        <div className="row-actions">
          <button
            type="button"
            className="chip-button"
            onClick={() => setDraft({ ...row })}
            disabled={busy}
            aria-label={`Change ${row.name}`}
          >
            Change
          </button>
          <ActionMenu
            label={`More for ${row.name}`}
            items={[
              {
                label: row.status === "active" ? "Switch off" : "Switch on",
                icon: row.status === "active" ? "ban" : "check",
                onClick: () =>
                  act(() =>
                    updatePaymentType(row.id, {
                      name: row.name,
                      needsReference: row.needsReference,
                      sortOrder: row.sortOrder,
                      status: row.status === "active" ? "inactive" : "active",
                    })
                  ),
              },
              {
                label: row.usedCount ? "Delete — used, switch it off" : "Delete",
                icon: "trash",
                danger: true,
                disabled: Boolean(row.usedCount),
                onClick: () => act(() => deletePaymentType(row.id)),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  return (
    <SectionCard
      id="settings-payment-types"
      icon="card"
      tone="info"
      title="Payment types"
      description="Name the ways guests pay under each method — meal cards, cheques, PhonePe — so their settlements can be totalled. Saved on its own."
    >
      <ErrorMessage message={error} />
      <SuccessMessage message={notice} />

      {canEdit && (
        <form className="payment-type-form" onSubmit={save}>
          <label className="field">
            <span>Under</span>
            <select
              value={draft.paymentMethod}
              onChange={(event) => setDraft({ ...draft, paymentMethod: event.target.value })}
              disabled={Boolean(draft.id)}
              title={draft.id ? "A type stays under the method it was made in" : undefined}
            >
              {BILL_PAYMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={60}
              placeholder="Pluxee meal card"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
            />
          </label>
          <label className="checkbox payment-type-ref">
            <input
              type="checkbox"
              checked={draft.needsReference}
              onChange={(event) => setDraft({ ...draft, needsReference: event.target.checked })}
            />
            <span>Ask for a reference (slip or cheque number)</span>
          </label>
          <div className="payment-type-actions">
            {draft.id && (
              <button type="button" className="button button-ghost" onClick={() => setDraft(EMPTY)} disabled={busy}>
                Cancel
              </button>
            )}
            <button type="submit" className="button button-secondary" disabled={busy || !draft.name.trim()}>
              {draft.id ? "Save type" : "Add type"}
            </button>
          </div>
        </form>
      )}

      <DataGrid
        id="settings-payment-types"
        caption="Payment types"
        variant="compact"
        columns={columns}
        rows={types}
        rowKey={(row) => row.id}
        loading={types === null && !loadError}
        error={loadError}
        onRetry={() => setReload((count) => count + 1)}
        empty="No payment types yet"
        emptyHint="Cash, card and UPI work as they are. Add a type for a meal card, a cheque or an app you want totalled apart."
        emptyIcon="card"
        rowClassName={(row) => (row.status === "active" ? "" : "dg-tone-muted")}
        rowNoun={["type", "types"]}
      />
    </SectionCard>
  );
}
