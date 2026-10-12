import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatusBadge from "../../../../components/StatusBadge";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import SheetImportModal from "../../inventory/pages/SheetImportModal";
import {
  createSupplier,
  deleteSupplier,
  listSuppliers,
  updateSupplier,
} from "../services/supplier.service";
import { getSupplierImportGuide, importSuppliers } from "../services/supplier.service";
import { getErrorMessage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import { niceDate } from "../../inventory/pages/stockFormat";
import { Tile } from "../../inventory/pages/stockUi";
import { count } from "../../../../services/format";
import "../../../../styles/stock.css";

const EMPTY = {
  name: "",
  code: "",
  contactPerson: "",
  mobile: "",
  email: "",
  address: "",
  gstNumber: "",
  paymentTerms: "",
  creditDays: "",
  status: "active",
};

export default function SuppliersPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("suppliers.manage");

  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // Thirty suppliers from the old system's export, in one go (sweep SW-B-12).
  const [importing, setImporting] = useState(false);

  const load = useCallback(
    () =>
      listSuppliers()
        .then(setSuppliers)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      const payload = { ...form, creditDays: form.creditDays === "" ? null : Number(form.creditDays) };

      if (editing.id) {
        await updateSupplier(editing.id, payload);
        setSuccess("Supplier updated");
      } else {
        await createSupplier(payload);
        setSuccess("Supplier created");
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
      await deleteSupplier(deleting.id);
      setDeleting(null);
      setSuccess("Supplier deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const openNew = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const openEdit = (supplier) => {
    setForm({
      name: supplier.name,
      code: supplier.code || "",
      contactPerson: supplier.contactPerson || "",
      mobile: supplier.mobile || "",
      email: supplier.email || "",
      address: supplier.address || "",
      gstNumber: supplier.gstNumber || "",
      paymentTerms: supplier.paymentTerms || "",
      creditDays: supplier.creditDays === null || supplier.creditDays === undefined ? "" : String(supplier.creditDays),
      status: supplier.status,
    });
    setFormError("");
    setEditing(supplier);
  };

  const creditText = (supplier) =>
    supplier.creditDays !== null && supplier.creditDays !== undefined
      ? supplier.creditDays === 0
        ? "Cash on delivery"
        : `${supplier.creditDays} days`
      : "—";

  // The list as a grid: S.No., search over name, code, contact, mobile and
  // GSTIN, sort by any heading, page through, export.
  const columns = [
    {
      key: "name",
      header: "Name",
      value: (supplier) => supplier.name,
      mobile: "title",
      pin: true,
      csv: (supplier) => supplier.name,
      render: (supplier) => (
        <span className="bo-cell-stack">
          <strong>{supplier.name}</strong>
          {supplier.code && <span className="muted small mono">{supplier.code}</span>}
        </span>
      ),
    },
    { key: "code", header: "Code", value: (supplier) => supplier.code || "", defaultHidden: true, searchable: true },
    {
      key: "contact",
      header: "Contact",
      value: (supplier) => supplier.contactPerson || "",
      searchable: true,
      render: (supplier) => (
        <span className="bo-cell-stack">
          <span>{supplier.contactPerson || "—"}</span>
          {supplier.mobile && <span className="muted small">{supplier.mobile}</span>}
        </span>
      ),
      mobile: "show",
    },
    { key: "mobile", header: "Mobile", value: (supplier) => supplier.mobile || "", defaultHidden: true, searchable: true },
    {
      key: "gstin",
      header: "GSTIN",
      value: (supplier) => supplier.gstNumber || "",
      searchable: true,
      render: (supplier) => <span className="mono small">{supplier.gstNumber || "—"}</span>,
      mobile: "show",
    },
    {
      key: "credit",
      header: "Credit",
      value: (supplier) => (supplier.creditDays === null || supplier.creditDays === undefined ? -1 : supplier.creditDays),
      csv: (supplier) => creditText(supplier),
      type: "number",
      align: "left",
      render: (supplier) => (
        <span className="bo-cell-stack small">
          <span>{creditText(supplier)}</span>
          {supplier.paymentTerms && <span className="muted">{supplier.paymentTerms}</span>}
        </span>
      ),
      mobile: "show",
    },
    { key: "orders", header: "Orders", type: "number", value: (supplier) => supplier.orderCount, mobile: "hide", width: 100 },
    {
      key: "bills",
      header: "Bills",
      type: "number",
      value: (supplier) => supplier.billCount,
      render: (supplier) => (
        <span className="bo-cell-stack">
          <span>{supplier.billCount}</span>
          {supplier.lastBillDate && <span className="muted small">last {niceDate(supplier.lastBillDate)}</span>}
        </span>
      ),
      mobile: "hide",
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (supplier) => (supplier.status === "active" ? "Active" : "Inactive"),
      render: (supplier) => <StatusBadge status={supplier.status} />,
      filter: "select",
      mobile: "show",
    },
  ];

  if (canManage) {
    columns.push({
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (supplier) => (
        <span className="row-actions">
          <Link className="link-button" to={`/purchasing/accounts?tab=statement&supplier=${supplier.id}`}>
            Statement
          </Link>
          <button type="button" className="link-button" onClick={() => openEdit(supplier)}>
            Edit
          </button>
          <ActionMenu
            label={`More actions for ${supplier.name}`}
            items={[{ label: "Delete supplier", icon: "trash", danger: true, onClick: () => setDeleting(supplier) }]}
          />
        </span>
      ),
    });
  }

  const active = suppliers.filter((supplier) => supplier.status === "active");
  const onCredit = active.filter((supplier) => Number(supplier.creditDays) > 0).length;
  const cashOnDelivery = active.filter((supplier) => supplier.creditDays === 0).length;
  // Bills from a supplier without a GSTIN go on the purchase register as
  // unregistered, so the accountant cannot claim their GST.
  const noGstin = active.filter((supplier) => !supplier.gstNumber).length;

  return (
    <div className="stack stk-page">
      <PageHeader
        icon="truck"
        title="Suppliers"
        description="The vendors you buy stock from: who to call, their GSTIN, and how long they give you to pay."
        action={
          canManage && (
            <div className="stk-actions">
              <button type="button" className="button button-secondary" onClick={() => setImporting(true)}>
                <Icon name="upload" size={16} /> Import
              </button>
              <button type="button" className="button" onClick={openNew}>
                <Icon name="plus" size={16} /> Add supplier
              </button>
            </div>
          )
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && suppliers.length > 0 && (
        <div className="stat-grid">
          <Tile
            icon="truck"
            label="Suppliers"
            value={count(active.length)}
            note={suppliers.length > active.length ? `active, plus ${count(suppliers.length - active.length)} inactive` : "all active"}
          />
          <Tile icon="calendar" label="On credit" value={count(onCredit)} note="bills fall due after their credit days" />
          <Tile icon="cash" label="Cash on delivery" value={count(cashOnDelivery)} note="paid when the goods arrive" />
          <Tile
            icon="receipt"
            label="No GSTIN on record"
            value={count(noGstin)}
            tone={noGstin > 0 ? "warning" : undefined}
            note={noGstin > 0 ? "their GST shows as unregistered" : "every active supplier has one"}
          />
        </div>
      )}

      <SectionCard
        icon="list"
        title="All suppliers"
        description={
          // Only people who can see the accounts have a Statement link on
          // each row; the others are not told about a link they do not have.
          canManage
            ? "Statement opens what you owe a supplier, bill by bill, with every payment and return."
            : "Who each supplier is, how to reach them, and the terms they sell on."
        }
        actions={suppliers.length > 0 && <span className="stk-count">{count(suppliers.length)} suppliers</span>}
        flush
      >
        <DataGrid
          id="suppliers"
          caption="Suppliers"
          columns={columns}
          rows={suppliers}
          rowKey={(supplier) => supplier.id}
          loading={loading}
          empty="No suppliers yet."
          emptyIcon="truck"
          emptyHint="Add the people you buy from — the vegetable vendor, the meat supplier, the dairy — to order from them and track what you owe. Or import them from a spreadsheet."
          emptyAction={
            canManage && (
              <button type="button" className="button" onClick={openNew}>
                <Icon name="plus" size={16} /> Add supplier
              </button>
            )
          }
          rowClassName={(supplier) => (supplier.status === "active" ? "" : "dg-tone-muted")}
          search="Name, mobile or GSTIN"
          exportName="suppliers"
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit supplier" : "Add supplier"}
          description="Who they are, how to reach them, and the terms they sell on."
          icon={editing.id ? "edit" : "truck"}
          onClose={() => setEditing(null)}
          width={620}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">Who they are</p>

            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={change("name")} required autoFocus maxLength={150} />
            </label>

            <label className="field">
              <span>Code</span>
              <input value={form.code} onChange={change("code")} maxLength={30} placeholder="FF01" />
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            <p className="section-heading field-wide">How to reach them</p>

            <label className="field">
              <span>Contact person</span>
              <input value={form.contactPerson} onChange={change("contactPerson")} />
            </label>

            <label className="field">
              <span>Mobile</span>
              <input value={form.mobile} onChange={change("mobile")} />
            </label>

            <label className="field">
              <span>Email</span>
              <input type="email" value={form.email} onChange={change("email")} />
            </label>

            <label className="field field-wide">
              <span>Address</span>
              <textarea rows={2} value={form.address} onChange={change("address")} />
            </label>

            <p className="section-heading field-wide">Tax and payment</p>

            <label className="field">
              <span>GSTIN</span>
              <input
                value={form.gstNumber}
                onChange={change("gstNumber")}
                maxLength={20}
                placeholder="37ABCDE1234F1Z5"
                style={{ textTransform: "uppercase" }}
              />
              <small className="muted">Shown on the purchase register; decides CGST + SGST or IGST</small>
            </label>

            <label className="field">
              <span>Credit days</span>
              <input
                type="number"
                min="0"
                max="365"
                step="1"
                value={form.creditDays}
                onChange={change("creditDays")}
                placeholder="15"
              />
              <small className="muted">Bills fall due this many days after the bill date (0 = cash on delivery)</small>
            </label>

            <label className="field">
              <span>Payment terms (note)</span>
              <input
                value={form.paymentTerms}
                onChange={change("paymentTerms")}
                placeholder="Weekly settlement on Mondays"
              />
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

      {importing && (
        <SheetImportModal
          title="Import suppliers from a spreadsheet"
          description="Add new suppliers and update existing ones after seeing every change, row by row."
          noun="supplier"
          nounPlural="suppliers"
          sampleName="suppliers-sample.csv"
          loadGuide={getSupplierImportGuide}
          runImport={importSuppliers}
          lead="A supplier is found by its GSTIN, then its code, then its mobile number, then its name. Only the columns in your file change; every GSTIN is checked character by character."
          promises={[
            {
              title: "Credit days set the due dates.",
              text: "Bills from a supplier fall due that many days after the bill date, and the ageing on Supplier accounts follows.",
            },
          ]}
          onClose={() => setImporting(false)}
          onImported={(message) => {
            setImporting(false);
            setSuccess(message);
            load();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete supplier"
          message={`Delete "${deleting.name}"? A supplier with orders, bills, returns or payments on record cannot be deleted — set them inactive instead.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
