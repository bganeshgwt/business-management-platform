import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  deleteExpenseCategory,
  getExpenseDefaults,
  listExpenseCategories,
  listExpenses,
  approveExpenses,
  setExpenseStatus,
  updateExpense,
  updateExpenseCategory,
} from "../services/expense.service";
import { listSuppliers } from "../../purchasing/services/supplier.service";
import { expenseFiles } from "../services/expense.service";
import AttachmentsModal from "./AttachmentsModal";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { money } from "@bmp/shared/format";
import { today } from "@bmp/shared/dates";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useShake from "../../../../hooks/useShake";
import { EXPENSE_PAYMENT_OPTIONS, paymentMethodLabel } from "../../../../services/labels";
import { Status } from "../../business-day/pages/moneyUi";
import { BusinessDateChip, StaleDayNotice } from "../../business-day/pages/StaleDay";
import useConfirm from "../../../../hooks/useConfirm";
import { toast } from "../../../../services/toast";
import { dateText } from "../../business-day/pages/moneyText";
import "../../../../styles/billing.css";
import "../../../../styles/cash.css";
import "../styles/attachments.css";
import "../styles/expenses.css";

const EMPTY = {
  expenseCategoryId: "",
  supplierId: "",
  // Filled when the form opens with the business day the till is trading on
  // (GET /expenses/defaults): cash paid at 00:40 belongs to the night before.
  expenseDate: "",
  amount: "",
  paymentMode: "cash",
  referenceNo: "",
  notes: "",
};

const EMPTY_CATEGORY = { name: "", description: "", status: "active" };

// Each state in words a new cashier understands, with its colour.
const STATES = {
  pending: { tone: "warning", label: "Waiting" },
  approved: { tone: "active", label: "Approved" },
  rejected: { tone: "inactive", label: "Rejected" },
};

const FILTERS = [
  ["", "All"],
  ["pending", "Waiting"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
];

// What a status picked with no dates shows (it looks across every day).
const ACROSS_DAYS = {
  pending: "Every entry still waiting for approval",
  approved: "Every approved expense",
  rejected: "Every rejected expense",
};

// How each payment mode is drawn beside its name.
const MODE_ICONS = { cash: "cash", card: "card", upi: "qr", bank: "store", other: "wallet" };

// Rows to a page: the data grid remembers the viewer's choice under its id
// (rmp.grid.expenses); the API pages, so the first request asks for the same
// size. Never required: a private window simply starts at 25.
const PAGE_SIZES = [25, 50, 100];
const GRID_ID = "expenses";

// What "Approve selected" may take: waiting, not petty cash from a drawer
// (approved there), and not cash of a drawer already counted.
const approvable = (expense) =>
  expense.expenseStatus === "pending" && !expense.fromDrawer && !(expense.drawerClosed && expense.paymentMode === "cash");

const sumPaise = (values) => values.reduce((total, value) => total + Math.round(Number(value || 0) * 100), 0) / 100;

const rememberedPageSize = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`rmp.grid.${GRID_ID}`) || "null");
    const value = Number(saved && saved.pageSize);

    return PAGE_SIZES.includes(value) ? value : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
};

export default function ExpensesPage() {
  const { hasPermission, hasFeature } = useAuth();
  const confirm = useConfirm();
  const canManage = hasPermission("expenses.manage");
  // Suppliers are part of Stock & recipes (Settings -> Features).
  const suppliersOn = hasFeature("stock_recipes");

  const [data, setData] = useState({ summary: null, items: [], total: 0 });
  const [categories, setCategories] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [statusFilter] = useQueryFilter("status");
  // The dates are kept in the address (a reload or a shared link keeps them)
  // and both are written in one go: two separate writes in one click would
  // lose the first.
  const [params, setParams] = useSearchParams();
  const fromParam = params.get("from") || "";
  const toParam = params.get("to") || "";
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(rememberedPageSize);
  const [loading, setLoading] = useState(true);
  // The list's own failure (shown inside the grid with "Try again") apart
  // from an action's (approve, delete), shown above the page.
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // The date a new expense takes and what the till is trading on. Loaded
  // first: "today" on this screen is the till's business day, not the
  // calendar (cash paid at 00:40 belongs to the night before).
  const [dating, setDating] = useState(null);
  const [datingReady, setDatingReady] = useState(false);
  const [formRef, shakeForm] = useShake();

  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [categoryForm, setCategoryForm] = useState(EMPTY_CATEGORY);
  const [editingCategoryId, setEditingCategoryId] = useState(null);

  // The list opens on today's business day (from the till's day to the
  // calendar's today, which differ only after midnight); older spending is a
  // date pick away. A status picked (or a link such as "3 waiting for
  // approval") looks across every day unless dates are picked too.
  const dayFrom = dating ? dating.expenseDate : today();
  const dayTo = dating ? dating.today : today();
  const acrossDays = Boolean(statusFilter);
  const fromDate = fromParam || (acrossDays ? "" : dayFrom);
  const toDate = toParam || (acrossDays ? "" : dayTo);
  const onToday = fromDate === dayFrom && toDate === dayTo;

  useEffect(() => {
    getExpenseDefaults()
      .then(setDating)
      .catch(() => setDating(null))
      .finally(() => setDatingReady(true));
  }, []);

  const load = useCallback(() => {
    if (!datingReady) {
      return Promise.resolve();
    }

    return listExpenses({
      status: statusFilter || undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
      page,
      pageSize,
    })
      .then((result) => {
        // The last row of the last page was deleted: show the page before.
        const pages = Math.max(1, Math.ceil(result.total / pageSize));

        if (page > pages) {
          setPage(pages);
          return;
        }

        setData(result);
        setLoadError("");
      })
      .catch((err) => setLoadError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [datingReady, statusFilter, fromDate, toDate, page, pageSize]);

  // "Export CSV" takes every expense in the filters, not just this page: the
  // API is asked page by page, 100 at a time.
  const fetchAll = async () => {
    const all = [];

    for (let next = 1; ; next += 1) {
      const result = await listExpenses({
        status: statusFilter || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        page: next,
        pageSize: 100,
      });
      all.push(...result.items);

      if (result.items.length < 100 || all.length >= result.total) {
        return all;
      }
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  // Any change of filter starts again from the first page. A status picked
  // here keeps the dates on show (today, unless others were picked): older
  // entries appear only when the date filter asks for them. Only a link that
  // means "everything still waiting" (the tile below, the dashboard, a
  // notification) looks across every day.
  const pickStatus = (value) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);

        if (value) {
          next.set("status", value);
        } else {
          next.delete("status");
        }

        next.set("from", fromDate || dayFrom);
        next.set("to", toDate || dayTo);

        return next;
      },
      { replace: true }
    );
    setPage(1);
  };

  const pickPage = ({ page: nextPage, pageSize: nextSize }) => {
    if (nextSize && nextSize !== pageSize) {
      setPageSize(nextSize);
      setPage(1);
      return;
    }

    setPage(nextPage);
  };

  const pickRange = (range) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);

        for (const [key, value] of [
          ["from", range.from],
          ["to", range.to],
        ]) {
          if (value) {
            next.set(key, value);
          } else {
            next.delete(key);
          }
        }

        return next;
      },
      { replace: true }
    );
    setPage(1);
  };

  const loadCategories = useCallback(
    () =>
      listExpenseCategories()
        .then(setCategories)
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    loadCategories();

    (suppliersOn ? listSuppliers() : Promise.resolve([]))
      .then(setSuppliers)
      .catch(() => setSuppliers([]));

    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, [loadCategories, suppliersOn]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      expenseCategoryId: Number(form.expenseCategoryId),
      supplierId: form.supplierId ? Number(form.supplierId) : null,
      expenseDate: form.expenseDate,
      amount: Number(form.amount),
      paymentMode: form.paymentMode,
      referenceNo: form.referenceNo || null,
      notes: form.notes || null,
    };

    try {
      if (editing.id) {
        await updateExpense(editing.id, payload);
        setSuccess("Expense updated");
      } else {
        await createExpense(payload);
        setSuccess("Expense recorded, waiting for approval");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
      shakeForm();
    } finally {
      setSaving(false);
    }
  };

  // The paper bill (photos, PDFs) of one expense. Opened from the
  // paperclip, and before approving an expense that carries one, so the
  // approver sees the bill they are approving.
  const [filesOf, setFilesOf] = useState(null);
  const filesId = filesOf ? filesOf.expense.id : null;
  const openFiles = useMemo(() => (filesId ? expenseFiles(filesId) : null), [filesId]);

  const approve = (expense) => {
    if (expense.attachmentCount > 0) {
      setFilesOf({ expense, approving: true });
      return;
    }

    setStatus(expense, "approved");
  };

  const setStatus = async (expense, status) => {
    try {
      await setExpenseStatus(expense.id, status);
      setSuccess(`Expense ${status}`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  // "Approve selected": the waiting ones among the rows ticked, in one go
  // (all or none). The total shown is sent too, so nothing is approved if an
  // amount changed in the meantime.
  const approveSelected = async (rows, clear) => {
    const chosen = rows.filter(approvable);

    if (chosen.length === 0) {
      return;
    }

    const total = sumPaise(chosen.map((expense) => expense.amount));
    const withBills = chosen.filter((expense) => expense.attachmentCount > 0).length;
    const skipped = rows.length - chosen.length;

    const yes = await confirm({
      title: `Approve ${chosen.length} ${chosen.length === 1 ? "expense" : "expenses"}?`,
      message: [
        `${money(total, currency)} in all. Approved expenses count in reports and come out of their drawers.`,
        withBills > 0 ? ` ${withBills} of them ${withBills === 1 ? "has" : "have"} a paper bill: open it from the paperclip first if you have not checked it.` : "",
        skipped > 0 ? ` ${skipped} ticked ${skipped === 1 ? "row is" : "rows are"} not waiting for approval and ${skipped === 1 ? "is" : "are"} left as ${skipped === 1 ? "it is" : "they are"}.` : "",
      ].join(""),
      confirmLabel: `Approve ${money(total, currency)}`,
      tone: "primary",
    });

    if (!yes) {
      return;
    }

    try {
      const result = await approveExpenses(
        chosen.map((expense) => expense.id),
        total
      );
      toast.success(`${result.count} ${result.count === 1 ? "expense" : "expenses"} approved · ${money(result.total, currency)}`);
      clear();
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      load();
    }
  };

  const saveCategory = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      if (editingCategoryId) {
        await updateExpenseCategory(editingCategoryId, categoryForm);
      } else {
        await createExpenseCategory(categoryForm);
      }

      setCategoryForm(EMPTY_CATEGORY);
      setEditingCategoryId(null);
      loadCategories();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const removeCategory = async (category) => {
    setFormError("");

    try {
      await deleteExpenseCategory(category.id);
      loadCategories();
    } catch (err) {
      setFormError(getErrorMessage(err));
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteExpense(deleting.id);
      setDeleting(null);
      setSuccess("Expense deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const openCategories = () => {
    setCategoriesOpen(true);
    setFormError("");
  };

  // A new expense is dated the business day the till is on, not the
  // calendar: a day still open after midnight keeps its own date.
  const startRecord = async () => {
    setForm({
      ...EMPTY,
      expenseCategoryId: categories[0] ? String(categories[0].id) : "",
    });
    setFormError("");
    setDating(null);
    setEditing({});

    try {
      const defaults = await getExpenseDefaults();
      setDating(defaults);
      setForm((all) => (all.expenseDate ? all : { ...all, expenseDate: defaults.expenseDate }));
    } catch (err) {
      setFormError(getErrorMessage(err));
    }
  };

  const startEdit = (expense) => {
    setForm({
      expenseCategoryId: String(expense.expenseCategoryId),
      supplierId: expense.supplierId ? String(expense.supplierId) : "",
      expenseDate: expense.expenseDate,
      amount: String(expense.amount),
      paymentMode: expense.paymentMode,
      referenceNo: expense.referenceNo || "",
      notes: expense.notes || "",
    });
    setFormError("");
    setEditing(expense);
    getExpenseDefaults()
      .then(setDating)
      .catch(() => setDating(null));
  };

  // Anything other than today's business day with every status.
  const filtered = Boolean(statusFilter) || !onToday;
  const rangeNote = !fromDate && !toDate ? "All dates" : onToday ? "Today's business day" : "In the dates picked";
  // A tile opens the entries it counted: its status, in the same dates.
  const showStatusInRange = (status) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);

        next.set("status", status);

        if (fromDate) {
          next.set("from", fromDate);
        }

        if (toDate) {
          next.set("to", toDate);
        }

        return next;
      },
      { replace: true }
    );
    setPage(1);
  };

  // Every entry still waiting, whatever its day.
  const showAllWaiting = () => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);

        next.set("status", "pending");
        next.delete("from");
        next.delete("to");

        return next;
      },
      { replace: true }
    );
    setPage(1);
  };

  const backToToday = () => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);

        next.delete("status");
        next.delete("from");
        next.delete("to");

        return next;
      },
      { replace: true }
    );
    setPage(1);
  };

  // What each row can do: approve (in reach), the rest behind the menu.
  const rowActions = (expense) => {
    if (expense.fromDrawer) {
      // Petty cash is changed where it was paid, so the drawer and the
      // expenses never disagree.
      return (
        <Link className="link-button small" to="/business-day?tab=drawers">
          On the drawer
        </Link>
      );
    }

    if (expense.expenseStatus === "pending" && expense.drawerClosed && expense.paymentMode === "cash") {
      // Its drawer is counted: approving would change a signed count, so it
      // can only be rejected or deleted.
      return (
        <ActionMenu
          label={`Actions for this ${money(expense.amount, currency)} expense`}
          items={[
            { label: "Reject", icon: "x-circle", onClick: () => setStatus(expense, "rejected") },
            { label: "Edit", icon: "edit", onClick: () => startEdit(expense) },
            { separator: true },
            { label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(expense) },
          ]}
        />
      );
    }

    if (expense.expenseStatus === "pending") {
      return (
        <span className="expense-row-actions">
          {/* Approving is the decision this page exists for, so it stays in
              reach; the rest go behind the menu, which also keeps Delete out
              of the way. */}
          <button type="button" className="button button-secondary button-sm" onClick={() => approve(expense)}>
            <Icon name="check" size={14} /> Approve
          </button>
          <ActionMenu
            label={`More actions for this ${money(expense.amount, currency)} expense`}
            items={[
              { label: "Reject", icon: "x-circle", onClick: () => setStatus(expense, "rejected") },
              { label: "Edit", icon: "edit", onClick: () => startEdit(expense) },
              { separator: true },
              { label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(expense) },
            ]}
          />
        </span>
      );
    }

    return <span className="muted small">—</span>;
  };

  const columns = [
    {
      // Who recorded it sits under the date, so the row fits a laptop screen.
      key: "date",
      header: "Date",
      type: "date",
      value: (expense) => expense.expenseDate,
      render: (expense) => (
        <span className="bd-when">
          <span className="nowrap">{dateText(expense.expenseDate)}</span>
          {expense.createdByName && <span className="muted small expense-by">by {expense.createdByName}</span>}
        </span>
      ),
      mobile: "subtitle",
      width: 112,
    },
    {
      key: "category",
      header: "Category",
      value: (expense) => expense.categoryName,
      mobile: "title",
      pin: true,
      // Sized so the whole row, with Approve and the menu, fits a laptop at
      // 1440 wide without scrolling sideways (a petty-cash row included).
      width: 176,
      render: (expense) => (
        <span className="bd-when">
          <strong>{expense.categoryName}</strong>
          <span className="muted small">{expense.outletName || "Shared restaurant expense"}</span>
          {(expense.fromDrawer || (expense.drawerClosed && expense.paymentMode === "cash")) && (
            <span className="expense-flags">
              {expense.fromDrawer && (
                <span className="expense-flag">
                  <Icon name="wallet" size={12} /> Petty cash from a drawer
                </span>
              )}
              {expense.drawerClosed && expense.paymentMode === "cash" && (
                <span className="expense-flag is-locked">
                  <Icon name="lock" size={12} /> Drawer counted
                </span>
              )}
            </span>
          )}
        </span>
      ),
      csv: (expense) => expense.categoryName,
    },
    {
      // Who was paid: the supplier, else what the person wrote ("NTF pest
      // control"), with the bill number under it.
      key: "paidTo",
      header: "Paid to",
      value: (expense) => expense.supplierName || expense.notes || "",
      mobile: "show",
      width: 184,
      csv: (expense) => [expense.supplierName, expense.notes].filter(Boolean).join(" — "),
      render: (expense) => (
        <span className="bd-when">
          {expense.supplierName ? (
            <strong className="expense-payee">{expense.supplierName}</strong>
          ) : expense.notes ? (
            <span className="expense-payee">{expense.notes}</span>
          ) : (
            <span className="muted">—</span>
          )}
          {expense.supplierName && expense.notes && <span className="small muted expense-note">{expense.notes}</span>}
          {expense.referenceNo && <span className="muted small mono">{expense.referenceNo}</span>}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      type: "money",
      value: (expense) => Number(expense.amount),
      mobile: "show",
      render: (expense) => <strong>{money(expense.amount, currency)}</strong>,
    },
    {
      key: "mode",
      header: "Mode",
      value: (expense) => paymentMethodLabel(expense.paymentMode),
      mobile: "show",
      width: 96,
      render: (expense) => (
        <span className="expense-mode">
          <Icon name={MODE_ICONS[expense.paymentMode] || "wallet"} size={14} />
          {paymentMethodLabel(expense.paymentMode)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (expense) => (STATES[expense.expenseStatus] || { label: expense.expenseStatus }).label,
      mobile: "show",
      render: (expense) => {
        const state = STATES[expense.expenseStatus] || { tone: "neutral", label: expense.expenseStatus };

        return (
          <span className="bd-when">
            <Status tone={state.tone}>{state.label}</Status>
            {expense.approvedByName && <span className="muted small">by {expense.approvedByName}</span>}
          </span>
        );
      },
    },
    {
      // The paperclip: how many photos or PDFs of the paper bill it carries.
      key: "files",
      header: "Bill",
      label: "Paper bill",
      type: "number",
      value: (expense) => expense.attachmentCount || 0,
      mobile: "show",
      width: 76,
      render: (expense) => (
        <button
          type="button"
          className="link-button att-clip"
          onClick={() => setFilesOf({ expense, approving: false })}
          aria-label={`Paper bill: ${expense.attachmentCount || 0} files`}
          title={expense.attachmentCount ? "Open the paper bill" : canManage ? "Attach the paper bill" : "No paper bill"}
        >
          <Icon name="file" size={14} />
          {expense.attachmentCount ? expense.attachmentCount : <span className="muted">{canManage ? "+" : "—"}</span>}
        </button>
      ),
    },
    {
      // Shown under the date; a column of its own only when chosen in Columns.
      key: "recordedBy",
      header: "Recorded by",
      value: (expense) => expense.createdByName || "",
      mobile: "hide",
      width: 124,
      defaultHidden: true,
      render: (expense) => <span className="small">{expense.createdByName || "—"}</span>,
    },
    ...(canManage ? [{ key: "actions", header: "", label: "Actions", type: "actions", render: rowActions }] : []),
  ];

  const categoryColumns = [
    {
      key: "name",
      header: "Name",
      value: (category) => category.name,
      mobile: "title",
      render: (category) => <strong>{category.name}</strong>,
    },
    {
      key: "description",
      header: "Description",
      value: (category) => category.description || "",
      mobile: "subtitle",
      // On a phone card a missing description is simply left out.
      render: (category, ctx) =>
        category.description ? (
          <span className="small">{category.description}</span>
        ) : ctx && ctx.card ? null : (
          <span className="muted">—</span>
        ),
    },
    { key: "entries", header: "Entries", type: "number", value: (category) => Number(category.expenseCount || 0) },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (category) => (
              <span className="expense-row-actions">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setCategoryForm({
                      name: category.name,
                      description: category.description || "",
                      status: category.status,
                    });
                    setEditingCategoryId(category.id);
                  }}
                >
                  Edit
                </button>
                <ActionMenu
                  label={`More actions for ${category.name}`}
                  items={[{ label: "Delete", icon: "trash", danger: true, onClick: () => removeCategory(category) }]}
                />
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="stack">
      <PageHeader
        icon="wallet"
        title="Expenses"
        description="Record spending for the outlet selected in the top bar. All outlets records shared restaurant costs. Approved expenses count in reports."
        action={
          canManage && (
            <>
              <button type="button" className="button button-secondary" onClick={openCategories}>
                <Icon name="layers" size={16} /> Categories
              </button>
              <button type="button" className="button" onClick={startRecord} disabled={categories.length === 0}>
                <Icon name="plus" size={16} /> Record expense
              </button>
            </>
          )
        }
      />

      <StaleDayNotice />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {categories.length === 0 && !loading && (
        <div className="alert alert-notice">
          Add an expense category first, such as Utilities or Rent.{" "}
          {canManage && (
            <button type="button" className="link-button" onClick={openCategories}>
              Add categories
            </button>
          )}
        </div>
      )}

      {data.summary && (
        <div className="stat-grid">
          <StatTile
            icon="check-circle"
            tone="success"
            label="Approved total"
            value={money(data.summary.approvedTotal, currency)}
            note={`${rangeNote}, counted in reports`}
            onClick={() => showStatusInRange("approved")}
          />
          <StatTile
            icon="clock"
            tone="warning"
            label="Waiting for approval"
            value={money(data.summary.pendingTotal, currency)}
            note={`${rangeNote}, not counted until approved`}
            onClick={() => showStatusInRange("pending")}
          />
          {/* Every entry still waiting, on any day: the list opens on today,
              and one left from last week still needs a decision. The tile
              opens exactly those. */}
          <StatTile
            icon="list"
            tone={data.summary.waitingCount > 0 ? "primary" : "neutral"}
            label="Entries to check"
            value={String(data.summary.waitingCount ?? data.summary.pendingCount)}
            note={
              data.summary.waitingCount > 0
                ? `${money(data.summary.waitingTotal, currency)} waiting, on any day`
                : "Nothing waiting on any day"
            }
            onClick={data.summary.waitingCount > 0 ? showAllWaiting : undefined}
          />
        </div>
      )}

      <SectionCard
        icon="receipt"
        title="Spending"
        description="Newest first. Approving is what makes an expense count in reports."
        flush
      >
        <div className="money-filterbar">
          <div className="filters">
            <div className="field">
              <span>Show</span>
              <div className="segmented" role="radiogroup" aria-label="Status">
                {FILTERS.map(([value, label]) => (
                  <button
                    type="button"
                    key={value || "all"}
                    role="radio"
                    aria-checked={statusFilter === value}
                    className={`segment ${statusFilter === value ? "is-active" : ""}`}
                    onClick={() => pickStatus(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <DateRangeFilter
              from={fromDate}
              to={toDate}
              label="expense dates"
              anchor={dating ? dating.expenseDate : undefined}
              onChange={pickRange}
            />
          </div>
          {!fromDate && !toDate && (
            <p className="small muted expense-range-note">
              {ACROSS_DAYS[statusFilter] || "Every expense"}, on any day.{" "}
              <button type="button" className="link-button" onClick={backToToday}>
                Back to today
              </button>
            </p>
          )}
        </div>

        <DataGrid
          id={GRID_ID}
          caption="Expenses"
          columns={columns}
          rows={data.items}
          rowKey={(expense) => expense.id}
          loading={loading}
          error={loadError}
          onRetry={load}
          empty={filtered ? "No expenses match." : "Nothing spent today yet."}
          emptyIcon="wallet"
          emptyHint={
            filtered
              ? "Try another status or wider dates."
              : "Record the gas bill, a plumber or the day's vegetables here, so the owner sees where the money went. Earlier days are a date pick away."
          }
          emptyAction={
            filtered ? (
              <button type="button" className="button button-secondary" onClick={backToToday}>
                Back to today
              </button>
            ) : (
              canManage &&
              categories.length > 0 && (
                <button type="button" className="button button-secondary" onClick={startRecord}>
                  <Icon name="plus" size={16} /> Record expense
                </button>
              )
            )
          }
          rowClassName={(expense) => (expense.expenseStatus === "rejected" ? "dg-tone-muted" : "")}
          // Tick the waiting ones to approve them together. Rows that are not
          // waiting can be ticked but are left out (the bar says how many).
          selectable={canManage && data.items.some(approvable)}
          bulkActions={(rows, clear) => {
            const chosen = rows.filter(approvable);
            const total = sumPaise(chosen.map((expense) => expense.amount));

            return (
              <>
                {rows.length > chosen.length && (
                  <span className="small muted">
                    {rows.length - chosen.length} not waiting · left out
                  </span>
                )}
                <button
                  type="button"
                  className="button button-sm"
                  disabled={chosen.length === 0}
                  onClick={() => approveSelected(rows, clear)}
                >
                  <Icon name="check" size={14} /> Approve selected ({chosen.length} · {money(total, currency)})
                </button>
              </>
            );
          }}
          server={{ total: data.total, page: data.page || page, pageSize, onChange: pickPage, fetchAll }}
          search={false}
          exportName="expenses"
        />
      </SectionCard>

      {filesOf && (
        <AttachmentsModal
          title={`Paper bill — ${filesOf.expense.categoryName}, ${money(filesOf.expense.amount, currency)}`}
          description={
            filesOf.approving
              ? "Check the bill before approving the expense."
              : `${dateText(filesOf.expense.expenseDate)}${filesOf.expense.supplierName ? ` · ${filesOf.expense.supplierName}` : ""}`
          }
          files={openFiles}
          canEdit={canManage}
          onClose={() => setFilesOf(null)}
          onChanged={() => load()}
          footer={
            filesOf.approving ? (
              <>
                <button type="button" className="button button-secondary" onClick={() => setFilesOf(null)}>
                  Not now
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    const expense = filesOf.expense;
                    setFilesOf(null);
                    setStatus(expense, "approved");
                  }}
                >
                  <Icon name="check" size={16} /> Approve {money(filesOf.expense.amount, currency)}
                </button>
              </>
            ) : undefined
          }
        />
      )}

      {editing && (
        <Modal
          title={editing.id ? "Edit expense" : "Record expense"}
          icon="wallet"
          description={
            editing.id
              ? "Only an expense still waiting for approval can change."
              : "It waits for a manager's approval before it counts."
          }
          onClose={() => setEditing(null)}
          width={620}
        >
          <form className="form-grid" onSubmit={save} ref={formRef}>
            <ErrorMessage message={formError} />

            {dating && dating.businessDay && dating.businessDay.pastMidnight && form.paymentMode === "cash" && (
              <div className="field-wide alert alert-info">
                The till is still on business day {dateText(dating.businessDay.businessDate)}. Cash paid now comes out of that
                day&apos;s drawer, so the expense is dated {dateText(dating.businessDay.businessDate)}.
              </div>
            )}

            <p className="section-heading field-wide">What was paid</p>

            <label className="field">
              <span>Category *</span>
              <select value={form.expenseCategoryId} onChange={change("expenseCategoryId")} required>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Amount ({currency}) *</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={change("amount")}
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span>Date *</span>
              <input
                type="date"
                value={form.expenseDate}
                onChange={change("expenseDate")}
                max={dating ? dating.today : undefined}
                required
              />
              {!editing.id && dating && form.expenseDate === dating.expenseDate && hasPermission("business_day.view") ? (
                // The open business day this goes on; amber with today's date
                // when that day was left open from an earlier date.
                <BusinessDateChip />
              ) : (
                <small className="muted">
                  {dating && dating.businessDay
                    ? `The business day it was paid in (the till is on ${dateText(dating.businessDay.businessDate)})`
                    : "The day the money went out"}
                </small>
              )}
            </label>

            <label className="field">
              <span>Payment mode</span>
              <select value={form.paymentMode} onChange={change("paymentMode")}>
                {EXPENSE_PAYMENT_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <p className="section-heading field-wide">Who to, and the proof</p>

            <label className="field">
              <span>Paid to (supplier)</span>
              <select value={form.supplierId} onChange={change("supplierId")}>
                <option value="">Not a supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Reference number</span>
              <input value={form.referenceNo} onChange={change("referenceNo")} maxLength={50} placeholder="Bill or receipt no." />
            </label>

            <label className="field field-wide">
              <span>Notes</span>
              <textarea rows={2} value={form.notes} onChange={change("notes")} placeholder="What it was for" />
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

      {categoriesOpen && (
        <Modal
          title="Expense categories"
          icon="layers"
          description="The headings spending is grouped under in reports, such as Rent, Gas or Repairs."
          onClose={() => setCategoriesOpen(false)}
          width={600}
        >
          <div className="stack">
            <ErrorMessage message={formError} />

            <DataGrid
              id="expense-categories"
              caption="Expense categories"
              variant="compact"
              pageSize={false}
              columns={categoryColumns}
              rows={categories}
              rowKey={(category) => category.id}
              rowClassName={(category) => (editingCategoryId === category.id ? "dg-tone-warning" : "")}
              empty="No categories yet."
              emptyIcon="layers"
              emptyHint="Add the first one below — Rent, Gas and Repairs are a good start."
            />

            {canManage && (
              <form className="expense-category-form" onSubmit={saveCategory}>
                <p className="section-heading">{editingCategoryId ? "Edit category" : "Add a category"}</p>
                <div className="expense-category-fields">
                  <label className="field">
                    <span>Name *</span>
                    <input
                      placeholder="Utilities"
                      value={categoryForm.name}
                      onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })}
                      required
                      maxLength={100}
                    />
                  </label>
                  <label className="field">
                    <span>Description</span>
                    <input
                      placeholder="Power, water, gas"
                      value={categoryForm.description}
                      onChange={(event) => setCategoryForm({ ...categoryForm, description: event.target.value })}
                    />
                  </label>
                </div>
                <div className="form-actions">
                  {editingCategoryId && (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        setCategoryForm(EMPTY_CATEGORY);
                        setEditingCategoryId(null);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                  <button type="submit" className="button" disabled={saving}>
                    {editingCategoryId ? "Update" : "Add category"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete expense"
          message={`Delete this ${money(deleting.amount, currency)} expense?`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
