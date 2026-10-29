import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createOutlet,
  deleteOutlet,
  getOutletUsage,
  updateOutlet,
} from "../../../../services/outlet.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { getInvoiceSeries, listOutletsWithSeries } from "../services/restaurant.service";
import "../styles/setup.css";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import "../../../../styles/reports.css";
import "../../../../styles/billing.css";

const EMPTY = {
  name: "",
  code: "",
  contact: "",
  address: "",
  gstNumber: "",
  orderPrefix: "",
  invoicePrefix: "",
  status: "active",
  fssaiNumber: "",
  upiVpa: "",
  upiPayeeName: "",
};

// A bill number of a series, as it prints: "INV-BR-0001", or numbering by
// financial year "BR/26-27/0001".
const sampleOf = (series, info) =>
  info && info.numbering === "financial_year" && info.financialYear
    ? `${series}/${info.financialYear}/0001`
    : `${series}-0001`;

// "1,204 bills, 3 tables and 2 floors"
const listWords = (items) => {
  const words = items.map((item) => `${item.count.toLocaleString("en-IN")} ${item.label}`);

  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0];
};

// "PRE-0003, PRE-0004 and 2 more": the open pre-orders' numbers, soonest due first.
const preorderNames = (numbers) => {
  const shown = numbers.length > 4 ? [...numbers.slice(0, 3), `${numbers.length - 3} more`] : numbers;

  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
};

// Closing or deleting an outlet changes what the top-bar switcher may offer,
// and the switcher reads its list once. The page is reloaded so every screen
// agrees — and if the outlet was the one this device was working in, the
// device goes back to All outlets first. Left pointing at a closed outlet,
// the dashboard, Reports and Orders all answered "not active" (16 errors on
// one screen). The message rides along in the address so it survives.
const reloadWith = (outlet, message) => {
  if (String(outletStorage.get() || "") === String(outlet.id)) {
    outletStorage.clear();
  }

  const url = new URL(window.location.href);
  url.searchParams.set("done", message);
  window.location.replace(url.toString());
};

export default function OutletsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("outlets.manage");
  const canReadReports = hasPermission("reports.view") && hasPermission("sales.view");
  // What was just done, carried over the reload (see reloadWith).
  const [done, setDone] = useQueryFilter("done", "");

  const [outlets, setOutlets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // The list failing to load is shown inside the list, with a way to try
  // again; `error` stays for the actions (removing an outlet).
  const [loadError, setLoadError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null); // null = closed, {} = new, {id} = edit
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // Removing an outlet: { outlet, usage } once what is recorded there is known.
  const [removing, setRemoving] = useState(null);
  // The open pre-orders of the outlet being removed (the usage counts them).
  const preordersOpen = (removing && removing.usage.openPreorders) || [];

  // The invoice series each till actually prints: an
  // outlet without a prefix of its own prints one worked out from its code.
  const [series, setSeries] = useState([]);
  // From the settings' series list, or (without the settings permission)
  // from the outlet itself (GET /outlets?series=1).
  const seriesOf = (outletId) =>
    series.find((row) => Number(row.outletId) === Number(outletId)) ||
    (outlets.find((outlet) => Number(outlet.id) === Number(outletId)) || {}).invoiceSeries ||
    null;
  const mainSeries = series.find((row) => row.outletId === null) || null;

  // `loading` starts true, so nothing is set synchronously while the effect runs.
  const load = useCallback(
    () =>
      listOutletsWithSeries()
        // Open outlets first: closed ones stay listed (their history is in
        // every report) but are rarely what anyone came here for.
        .then((rows) => {
          setOutlets([...rows].sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1)));
          setLoadError("");
        })
        .catch((err) => setLoadError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getInvoiceSeries()
      .then(setSeries)
      .catch(() => setSeries([]));
  }, [outlets]);

  // Series used by more than one open till (main counter included), each
  // once, with the outlet to fix: one without a prefix of its own first.
  const seriesClashes = (() => {
    const seen = new Map();

    for (const outlet of outlets.filter((one) => one.status === "active")) {
      const row = seriesOf(outlet.id);

      if (!row || !row.series || !row.sharedWith || row.sharedWith.length === 0) {
        continue;
      }

      const entry = seen.get(row.series) || { series: row.series, names: [...row.sharedWith], outlets: [] };
      entry.outlets.push({ outlet, derived: row.derived });
      if (!entry.names.includes(outlet.name)) {
        entry.names.push(outlet.name);
      }
      seen.set(row.series, entry);
    }

    return [...seen.values()].map((entry) => ({
      series: entry.series,
      names: entry.names,
      fix: (entry.outlets.find((item) => item.derived) || entry.outlets[0] || {}).outlet || null,
    }));
  })();

  const retry = () => {
    setLoadError("");
    setLoading(true);
    load();
  };

  const openNew = () => {
    setDone("");
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const openEdit = (outlet) => {
    setDone("");
    setForm({
      name: outlet.name,
      code: outlet.code,
      contact: outlet.contact || "",
      address: outlet.address || "",
      gstNumber: outlet.gst_number || "",
      orderPrefix: outlet.order_prefix || "",
      invoicePrefix: outlet.invoice_prefix || "",
      status: outlet.status,
      fssaiNumber: outlet.fssai_number || "",
      upiVpa: outlet.upi_vpa || "",
      upiPayeeName: outlet.upi_payee_name || "",
    });
    setFormError("");
    setEditing(outlet);
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      if (editing.id) {
        await updateOutlet(editing.id, form);

        // Opened or closed: the top bar's list changes with it.
        if (form.status !== editing.status) {
          reloadWith(
            editing,
            form.status === "inactive"
              ? `"${form.name}" is closed: it takes no more orders and has left the outlet list at the top. Its history stays in every report.`
              : `"${form.name}" is open again and back in the outlet list at the top.`
          );
          return;
        }

        setSuccess(`"${form.name}" saved`);
      } else {
        await createOutlet(form);
        setSuccess(`"${form.name}" added`);
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Delete asks first what is recorded at the outlet. One that has sold,
  // bought or counted anything is never deleted — its history belongs to the
  // accounts — so the choice offered is to close it instead.
  const startRemove = async (outlet) => {
    setError("");
    setSuccess("");
    setDone("");

    try {
      setRemoving({ outlet, usage: await getOutletUsage(outlet.id) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteOutlet(removing.outlet.id);
      reloadWith(removing.outlet, `"${removing.outlet.name}" deleted`);
      return;
    } catch (err) {
      setError(getErrorMessage(err));
      setRemoving(null);
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async () => {
    const { outlet } = removing;
    setSaving(true);

    try {
      await updateOutlet(outlet.id, {
        name: outlet.name,
        code: outlet.code,
        contact: outlet.contact || "",
        address: outlet.address || "",
        gstNumber: outlet.gst_number || "",
        orderPrefix: outlet.order_prefix || "",
        invoicePrefix: outlet.invoice_prefix || "",
        status: "inactive",
      });
      reloadWith(
        outlet,
        `"${outlet.name}" is closed: it takes no more orders and has left the outlet list at the top. Its history stays in every report.`
      );
      return;
    } catch (err) {
      setError(getErrorMessage(err));
      setRemoving(null);
    } finally {
      setSaving(false);
    }
  };

  // The list's columns. Edit and Remove keep their old places: Edit on the
  // row, Remove in the menu.
  const columns = [
    {
      key: "name",
      header: "Name",
      value: (outlet) => outlet.name,
      mobile: "title",
      pin: true,
      filter: "text",
      render: (outlet) => (
        <span className="outlet-name-cell">
          <span className={`outlet-mark ${outlet.status === "active" ? "" : "is-closed"}`} aria-hidden="true">
            <Icon name="store" size={17} />
          </span>
          <span>
            <strong>{outlet.name}</strong>
            {outlet.own_store && <span className="muted small">keeps its own stock</span>}
          </span>
        </span>
      ),
    },
    {
      key: "code",
      header: "Code",
      value: (outlet) => outlet.code,
      mobile: "show",
      render: (outlet) => <span className="mono nowrap">{outlet.code}</span>,
    },
    {
      key: "gstin",
      header: "GSTIN",
      value: (outlet) => outlet.gst_number,
      mobile: "show",
      csv: (outlet) => outlet.gst_number || "",
      render: (outlet) =>
        outlet.gst_number ? (
          <span className="mono nowrap">{outlet.gst_number}</span>
        ) : (
          <span className="muted small nowrap">the restaurant&apos;s</span>
        ),
    },
    {
      key: "series",
      header: "Bills print",
      value: (outlet) => (seriesOf(outlet.id) ? seriesOf(outlet.id).example : ""),
      mobile: "show",
      render: (outlet) => {
        const row = seriesOf(outlet.id);

        return row ? (
          <span className="outlet-series">
            <span className="mono nowrap">{row.example}</span>
            <span className="muted small">
              {row.derived ? "from its code" : "its own prefix"}
              {row.sharedWith.length > 0 ? ` · shared with ${row.sharedWith.join(", ")}` : ""}
            </span>
          </span>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
    {
      // The number the next bill here gets, read from the counter bills are
      // numbered from; red when another till numbers from the same series.
      key: "nextBill",
      header: "Next bill no.",
      value: (outlet) => (seriesOf(outlet.id) ? seriesOf(outlet.id).nextNumber : ""),
      mobile: "show",
      render: (outlet) => {
        const row = seriesOf(outlet.id);

        if (!row || !row.nextNumber) {
          return <span className="muted">—</span>;
        }

        const clash = outlet.status === "active" && row.sharedWith && row.sharedWith.length > 0;

        return (
          <span
            className={`mono nowrap outlet-next-bill ${clash ? "is-clash" : ""}`}
            title={clash ? `Shares its numbers with ${row.sharedWith.join(", ")}` : `${row.issued || 0} bills numbered in this series`}
          >
            {row.nextNumber}
          </span>
        );
      },
    },
    {
      key: "fssai",
      header: "FSSAI licence",
      value: (outlet) => outlet.fssai_number,
      csv: (outlet) => outlet.fssai_number || "",
      mobile: "show",
      render: (outlet) =>
        outlet.fssai_number ? (
          <span className="mono nowrap">{outlet.fssai_number}</span>
        ) : (
          <span className="badge badge-warning nowrap" title="A licence belongs to a premises: bills here print the restaurant's number">
            Uses the restaurant&apos;s
          </span>
        ),
    },
    { key: "contact", header: "Contact", value: (outlet) => outlet.contact, mobile: "show" },
    { key: "address", header: "Address", value: (outlet) => outlet.address, mobile: "show", filter: "text", minWidth: 140 },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (outlet) => outlet.status,
      filter: "select",
      filterOptions: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
      mobile: "subtitle",
      render: (outlet) => (
        <>
          <StatusBadge status={outlet.status} />
          {/* A closed outlet is not in the top bar any more; its
              history (and its last GST return) is read from here. */}
          {outlet.status !== "active" && canReadReports && (
            <div className="small">
              <Link to={`/reports?outlet=${outlet.id}`}>Read its reports →</Link>
            </div>
          )}
        </>
      ),
    },
    canManage && {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (outlet) => (
        <div className="row-actions">
          {/* Edit is the everyday action; removing an outlet is rare and
              asks first, so it waits in the menu. */}
          <button type="button" className="button button-ghost button-sm" onClick={() => openEdit(outlet)}>
            <Icon name="edit" size={15} /> Edit
          </button>
          <ActionMenu
            label={`More for ${outlet.name}`}
            items={[{ label: "Remove…", icon: "trash", danger: true, onClick: () => startRemove(outlet) }]}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="stack">
      <PageHeader
        icon="store"
        title="Outlets"
        description="Branches of this restaurant. Pick one in the top bar and every report and the dashboard show that outlet alone."
        action={
          canManage && (
            <button type="button" className="button" onClick={openNew}>
              <Icon name="plus" size={16} /> Add outlet
            </button>
          )
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success || done} />

      {/* Two open tills numbering bills under one prefix take turns on one
          counter: no number repeats, but neither runs 1, 2, 3 without gaps,
          which an outlet's GST documents table and accountant expect. */}
      {seriesClashes.map((clash) => (
        <div key={clash.series} className="alert alert-danger outlet-series-warning" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <strong>
              {clash.names.length === 2 ? "Two" : clash.names.length} tills share <span className="mono">{clash.series}</span>
            </strong>{" "}
            ({clash.names.join(", ")}): their bill numbers take turns on one series, so each one&apos;s bills skip numbers.
            Give {clash.fix ? `"${clash.fix.name}"` : "one of them"} a prefix of its own.
          </span>
          {canManage && clash.fix && (
            <button type="button" className="button button-secondary button-sm" onClick={() => openEdit(clash.fix)}>
              <Icon name="edit" size={14} /> Fix {clash.fix.name}
            </button>
          )}
        </div>
      ))}

      <SectionCard
        icon="list"
        title="Your outlets"
        description={
          loading || outlets.length === 0
            ? "Open outlets first. A closed outlet keeps its history in every report."
            : `${outlets.filter((outlet) => outlet.status === "active").length} open · ${
                outlets.filter((outlet) => outlet.status !== "active").length
              } closed. A closed outlet keeps its history in every report.`
        }
        flush
      >
        <DataGrid
          id="outlets"
          caption="Outlets"
          columns={columns}
          rows={outlets}
          rowKey={(outlet) => outlet.id}
          loading={loading}
          error={loadError}
          onRetry={retry}
          empty="No outlets yet."
          emptyIcon="store"
          emptyHint="Add your first branch. Until then, every bill belongs to the restaurant as a whole."
          emptyAction={
            canManage && (
              <button type="button" className="button button-secondary" onClick={openNew}>
                <Icon name="plus" size={16} /> Add outlet
              </button>
            )
          }
          rowClassName={(outlet) => (outlet.status === "active" ? "" : "dg-tone-muted")}
          exportName="outlets"
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit outlet" : "Add outlet"}
          description={
            editing.id
              ? "Closing an outlet stops its orders and bills; its history stays in every report."
              : "A new branch. Name and code are needed; the rest can be filled in later."
          }
          icon="store"
          onClose={() => setEditing(null)}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={change("name")} required autoFocus />
            </label>

            <label className="field">
              <span>Code</span>
              <input value={form.code} onChange={change("code")} required placeholder="RJY001" maxLength={30} />
            </label>

            <label className="field">
              <span>Contact</span>
              <input value={form.contact} onChange={change("contact")} />
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive (closed)</option>
              </select>
            </label>

            <label className="field field-wide">
              <span>GSTIN of this outlet</span>
              <input
                value={form.gstNumber}
                onChange={(event) => setForm({ ...form, gstNumber: event.target.value.toUpperCase() })}
                placeholder="Leave empty to use the restaurant's GSTIN"
                maxLength={20}
                className="mono"
              />
              <small className="muted">
                Only for a branch registered separately — usually one in another state. Its GST filing pack
                is headed with this number.
              </small>
            </label>

            <label className="field field-wide">
              <span>Address</span>
              <textarea rows={2} value={form.address} onChange={change("address")} />
            </label>

            <label className="field field-wide">
              <span>FSSAI licence number</span>
              <input
                value={form.fssaiNumber}
                onChange={(event) => setForm({ ...form, fssaiNumber: event.target.value.replace(/[^0-9]/g, "").slice(0, 14) })}
                placeholder="14 digits"
                inputMode="numeric"
                pattern="[0-9]{14}"
                title="An FSSAI licence number is 14 digits"
                className="mono"
              />
              {form.fssaiNumber ? (
                <small className="muted">Printed on this outlet&apos;s bills.</small>
              ) : (
                <small className="text-warning">
                  No licence of its own: bills here print the restaurant&apos;s FSSAI number. A licence belongs to a
                  premises, so each branch should have its own.
                </small>
              )}
            </label>

            <label className="field">
              <span>Order prefix</span>
              <input value={form.orderPrefix} onChange={change("orderPrefix")} placeholder="Restaurant default" maxLength={10} className="mono" />
            </label>

            <label className="field">
              <span>Invoice prefix</span>
              <input
                value={form.invoicePrefix}
                onChange={(event) => setForm({ ...form, invoicePrefix: event.target.value.toUpperCase() })}
                placeholder={editing.id && seriesOf(editing.id) ? seriesOf(editing.id).series : "Worked out from the code"}
                maxLength={mainSeries && mainSeries.numbering === "financial_year" ? 4 : 10}
                pattern="[A-Za-z0-9][A-Za-z0-9\/\-]*"
                title="Letters, digits, - and / only: GST allows nothing else in an invoice number"
                className="mono"
              />
              <small className="muted">
                {form.invoicePrefix
                  ? <>Bills will print like <span className="mono">{sampleOf(form.invoicePrefix, mainSeries)}</span></>
                  : editing.id && seriesOf(editing.id)
                    ? <>Empty: bills print like <span className="mono">{seriesOf(editing.id).example}</span></>
                    : "Empty: a series is worked out from the outlet's code"}
                {mainSeries && mainSeries.numbering === "financial_year" ? " · at most 4 characters (numbered by year)" : ""}
              </small>
            </label>

            <label className="field">
              <span>UPI ID</span>
              <input
                value={form.upiVpa}
                onChange={change("upiVpa")}
                placeholder="Restaurant's UPI ID"
                maxLength={100}
                className="mono"
              />
              <small className="muted">Only when this outlet banks on its own: its bills&apos; QR codes pay here.</small>
            </label>

            <label className="field">
              <span>Name on UPI</span>
              <input value={form.upiPayeeName} onChange={change("upiPayeeName")} placeholder={form.name} maxLength={100} />
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

      {removing && (
        <Modal
          title={`Remove "${removing.outlet.name}"`}
          icon={removing.usage.mustDeactivate || removing.usage.setup.length > 0 || preordersOpen.length > 0 ? "alert" : "trash"}
          onClose={() => setRemoving(null)}
          width={480}
        >
          {preordersOpen.length > 0 ? (
            // Pre-orders still to bake and hand over here: the outlet can be
            // neither closed nor deleted until they are handed over or cancelled.
            <>
              <p>
                {preordersOpen.length === 1 ? "One pre-order is" : `${preordersOpen.length} pre-orders are`} still open
                here, to be baked and handed over at this outlet ({preorderNames(preordersOpen)}). Until{" "}
                {preordersOpen.length === 1 ? "it is" : "they are"} handed over or cancelled, &quot;{removing.outlet.name}&quot; can
                be neither closed nor deleted.
              </p>
              <p className="muted small">Hand them over or cancel them in Pre-orders &amp; cakes, then come back here.</p>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={() => setRemoving(null)}>
                  Keep it open
                </button>
                <Link to="/preorders" className="button">
                  Open Pre-orders &amp; cakes
                </Link>
              </div>
            </>
          ) : removing.usage.mustDeactivate ? (
            <>
              <p>
                This outlet has {listWords(removing.usage.history)} on record. They are part of your accounts and
                GST return, so the outlet cannot be deleted.
              </p>
              <p className="muted small">
                Closing it (setting it Inactive) stops it taking orders, bills and stock, and takes it off the
                outlet list at the top. Its history stays in every report.
              </p>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={() => setRemoving(null)}>
                  Keep it open
                </button>
                {removing.outlet.status === "active" ? (
                  <button type="button" className="button" onClick={deactivate} disabled={saving}>
                    {saving ? "Working…" : "Close the outlet"}
                  </button>
                ) : (
                  <span className="muted small">It is already inactive.</span>
                )}
              </div>
            </>
          ) : removing.usage.setup.length > 0 ? (
            <>
              <p>
                {listWords(removing.usage.setup)} still belong to this outlet. Move them to another outlet first
                (Users, Staff, Tables), or close the outlet instead.
              </p>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
                {removing.outlet.status === "active" && (
                  <button type="button" className="button" onClick={deactivate} disabled={saving}>
                    {saving ? "Working…" : "Close the outlet"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p>
                Nothing has been recorded at &quot;{removing.outlet.name}&quot;, so it can be deleted. This cannot be
                undone.
              </p>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
                <button type="button" className="button button-danger" onClick={confirmDelete} disabled={saving}>
                  <Icon name="trash" size={16} />
                  {saving ? "Working…" : "Delete outlet"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
