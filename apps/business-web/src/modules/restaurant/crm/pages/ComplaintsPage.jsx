import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import GuestPicker from "./GuestPicker";
import {
  createComplaint,
  listComplaintAssignees,
  listComplaints,
  lookupComplaintReference,
  updateComplaint,
} from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { getSettings } from "../../setup/services/restaurant.service";
import { count, duration, money } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { orderTypeLabel } from "../../../../services/labels";
import { formatMobile, mobileHint } from "../../../../services/phone";
import { COMPENSATION_OPTIONS, compensationCosts, compensationLabel, shortDate } from "../../../../services/guestBook";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useQueryPatch from "./useQueryPatch";
import "../styles/crm.css";

const CATEGORY_LABELS = {
  food: "Food",
  service: "Service",
  delivery: "Delivery",
  billing: "Billing",
  hygiene: "Hygiene",
  other: "Other",
};

const PRIORITY_LABELS = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const STATUS_LABELS = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

// The list opens on what still needs doing ("Still open": open and in
// progress), the dashboard's "complaints still open" tile links here with the
// same, and "All" is a choice of its own.
const STILL_OPEN = "open,in_progress";
const STATUS_FILTERS = [
  { value: STILL_OPEN, label: "Still open" },
  { value: "all", label: "All" },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

// A complaint still open after this long is shown in red.
const LATE_HOURS = 24;
const isOpen = (complaint) => complaint.complaintStatus === "open" || complaint.complaintStatus === "in_progress";
const hoursOpen = (complaint) => (Date.now() - new Date(complaint.createdAt).getTime()) / 3600000;

const EMPTY = {
  guest: null,
  customerName: "",
  customerMobile: "",
  subject: "",
  description: "",
  category: "food",
  priority: "medium",
  assignedTo: "",
  complaintStatus: "open",
  resolution: "",
  reference: "",
  compensationType: "",
  compensationValue: "",
  compensationNotes: "",
};

// The most the API hands back in one request (crm.controller listComplaints).
const API_MAX = 200;
const URL_DEFAULTS = { from: "0", status: STILL_OPEN };

const statusBadge = (status) =>
  status === "open" ? "badge-danger" : status === "in_progress" ? "badge-warning" : status === "closed" ? "badge-neutral" : "badge-active";

// The average time to resolve, said the way a manager would: "0 h" read as a
// fault when complaints were closed within minutes, and "52 h" makes the eye
// divide by 24.
const resolveTime = (hours) => {
  if (hours < 1) {
    return "Resolved within the hour, on average";
  }

  if (hours < 48) {
    return `${hours} h to resolve on average`;
  }

  return `${Math.round((hours / 24) * 10) / 10} days to resolve on average`;
};

// Priority as an arrow and a word, so High reads as urgent without the red.
const PRIORITY_ICONS = { high: "arrow-up", medium: "minus", low: "arrow-down" };

// "1 complaint matches these filters", "No complaint matches…": the count
// and the verb agree.
const logSummary = (total, filtered) => {
  if (total === 0) {
    return filtered ? "No complaint matches these filters." : "No complaints yet.";
  }

  const what = `${count(total)} ${total === 1 ? "complaint" : "complaints"}`;

  return filtered ? `${what} ${total === 1 ? "matches" : "match"} these filters.` : `${what}.`;
};

// "INV-2891 · ₹1,980 · 12 Sep · Harish Kumar": what the complaint is about,
// shown before saving so the wrong bill is caught at once.
function ReferenceCard({ match, currency }) {
  return (
    <div className="crm-ref-card">
      <strong className="mono crm-ref-number">
        <Icon name="check-circle" size={15} />
        {match.billNumber || match.orderNumber}
      </strong>
      <span className="small">
        {[
          match.billNumber && match.orderNumber ? `order ${match.orderNumber}` : null,
          orderTypeLabel(match.orderType),
          money(match.total, currency),
          shortDate(match.at),
          match.billStatus === "void" ? "void bill" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className="small muted">
        {match.guestName
          ? `Guest: ${match.guestName}${match.guestMobile ? ` · ${formatMobile(match.guestMobile) || match.guestMobile}` : ""}`
          : "No guest on this bill"}
      </span>
    </div>
  );
}

export default function ComplaintsPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("feedback.manage");
  const canPickGuest = hasPermission("customers.view");
  // A whole list with guests' names and numbers leaves the building only
  // with customers.export, as the guest book's own export does.
  const canExport = hasPermission("customers.export");

  const [data, setData] = useState(null);
  const [staff, setStaff] = useState([]);
  const [statusParam] = useQueryFilter("status", STILL_OPEN);
  // "all" asks the API for every state.
  const statusFilter = statusParam === "all" ? "" : statusParam;
  // Still open: by priority, then the longest-waiting first.
  const sort = statusFilter === STILL_OPEN ? "age" : undefined;
  const [toResolve, setToResolve] = useState(null);
  const [resolution, setResolution] = useState("");
  const [quickBusy, setQuickBusy] = useState(null);
  const [search] = useQueryFilter("q");
  const [offsetText, setOffsetText] = useQueryFilter("from", "0");
  const patch = useQueryPatch(URL_DEFAULTS);
  const [typed, setTyped] = useState(search);
  // The rows-per-page this viewer chose last time, so the first request
  // already asks for it.
  const [limit, setLimit] = useState(() => rememberedPageSize("crm-complaints", 25));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [match, setMatch] = useState(null);
  const [matchError, setMatchError] = useState("");
  const [finding, setFinding] = useState(false);

  const [currency, setCurrency] = useState("₹");
  const offset = Math.max(0, Number(offsetText) || 0);

  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol || "₹"))
      .catch(() => setCurrency("₹"));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (typed.trim() !== search) {
        patch({ q: typed.trim(), from: 0 });
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [typed, search, patch]);

  const load = useCallback(
    () =>
      listComplaints({ status: statusFilter || undefined, search: search || undefined, sort, limit, offset })
        .then((result) => {
          // A page that emptied (or an old link past the end) steps back to
          // the last page that has something on it.
          if (result.items.length === 0 && result.total > 0 && offset > 0) {
            setOffsetText(String(Math.floor((result.total - 1) / limit) * limit));
            return;
          }

          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [statusFilter, search, sort, limit, offset, setOffsetText]
  );

  useEffect(() => {
    load();
  }, [load]);

  // "Export CSV" takes every complaint that matches, not only the page on
  // show: the same list call, a page of 200 at a time.
  const fetchAll = async () => {
    const all = [];

    for (let at = 0; ; at += API_MAX) {
      const result = await listComplaints({ status: statusFilter || undefined, search: search || undefined, sort, limit: API_MAX, offset: at });
      all.push(...result.items);

      if (result.items.length === 0 || all.length >= result.total) {
        return all;
      }
    }
  };

  // Only this restaurant's own active staff can be handed a complaint.
  useEffect(() => {
    if (!canManage) {
      return;
    }

    listComplaintAssignees()
      .then(setStaff)
      .catch(() => setStaff([]));
  }, [canManage]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  // "Assign to me" and the quick Resolve: the same update as the form, with
  // everything else as it is (bill, guest and make-good are left untouched).
  const quickUpdate = async (complaint, changes, done) => {
    setQuickBusy(complaint.id);
    setError("");

    try {
      await updateComplaint(complaint.id, {
        subject: complaint.subject,
        description: complaint.description || null,
        category: complaint.category,
        priority: complaint.priority,
        assignedTo: complaint.assignedTo || null,
        complaintStatus: complaint.complaintStatus,
        resolution: complaint.resolution || null,
        ...changes,
      });
      toast.success(done);
      load();
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setQuickBusy(null);
    }
  };

  const meAssignable = Boolean(user && staff.some((member) => Number(member.id) === Number(user.id)));

  const assignToMe = (complaint) =>
    quickUpdate(
      complaint,
      { assignedTo: user.id, complaintStatus: complaint.complaintStatus === "open" ? "in_progress" : complaint.complaintStatus },
      `"${complaint.subject}" is now with you`
    );

  const submitResolve = async (event) => {
    event.preventDefault();

    if (await quickUpdate(toResolve, { complaintStatus: "resolved", resolution: resolution.trim() }, `"${toResolve.subject}" resolved`)) {
      setToResolve(null);
    }
  };

  const open = (complaint) => {
    setFormError("");
    setMatchError("");

    if (!complaint) {
      setForm(EMPTY);
      setMatch(null);
      setEditing({});
      return;
    }

    setForm({
      ...EMPTY,
      customerName: complaint.customerName || "",
      customerMobile: complaint.customerMobile ? formatMobile(complaint.customerMobile) || complaint.customerMobile : "",
      subject: complaint.subject,
      description: complaint.description || "",
      category: complaint.category,
      priority: complaint.priority,
      assignedTo: complaint.assignedTo ? String(complaint.assignedTo) : "",
      complaintStatus: complaint.complaintStatus,
      resolution: complaint.resolution || "",
      reference: complaint.billNumber || complaint.orderNumber || "",
      compensationType: complaint.compensationType || "",
      compensationValue: complaint.compensationValue ? String(complaint.compensationValue) : "",
      compensationNotes: complaint.compensationNotes || "",
    });
    setMatch(null);
    setEditing(complaint);
  };

  const findReference = async () => {
    const reference = form.reference.trim();

    if (!reference) {
      return;
    }

    setFinding(true);
    setMatchError("");

    try {
      setMatch(await lookupComplaintReference(reference));
    } catch (err) {
      setMatch(null);
      setMatchError(getErrorMessage(err));
    } finally {
      setFinding(false);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const reference = form.reference.trim();
    const costs = compensationCosts(form.compensationType);
    const payload = {
      subject: form.subject,
      description: form.description || null,
      category: form.category,
      priority: form.priority,
      assignedTo: form.assignedTo ? Number(form.assignedTo) : null,
      reference: match ? match.billNumber || match.orderNumber : reference || null,
      compensationType: form.compensationType || null,
      compensationValue: costs ? Number(form.compensationValue || 0) : 0,
      compensationNotes: form.compensationType ? form.compensationNotes || null : null,
    };

    try {
      if (editing.id) {
        // A masked mobile (a role without "manage customers") is never sent
        // back: it would overwrite the real number with X's.
        const shown = editing.customerMobile ? formatMobile(editing.customerMobile) || editing.customerMobile : "";
        const mobileChanged = form.customerMobile !== shown && !/X/.test(form.customerMobile);
        await updateComplaint(editing.id, {
          ...payload,
          complaintStatus: form.complaintStatus,
          resolution: form.resolution || null,
          ...(mobileChanged ? { customerMobile: form.customerMobile || null } : {}),
        });
        setSuccess("Complaint updated");
      } else {
        await createComplaint({
          ...payload,
          customerId: form.guest ? form.guest.id : null,
          customerName: form.guest ? null : form.customerName || null,
          customerMobile: form.guest ? null : form.customerMobile || null,
        });
        setSuccess("Complaint logged");
        setOffsetText("0");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const summary = data ? data.summary : null;
  const items = data ? data.items : [];
  const mobile = mobileHint(form.customerMobile);
  const costs = compensationCosts(form.compensationType);
  const resolving = ["resolved", "closed"].includes(form.complaintStatus);

  return (
    <div className="stack crm-page">
      <PageHeader
        icon="alert"
        title="Complaints"
        description="Log an issue against its bill, hand it to someone, and record how it was put right."
        action={
          canManage && (
            <button type="button" className="button" onClick={() => open(null)}>
              <Icon name="plus" size={16} /> Log complaint
            </button>
          )
        }
      />

      {/* A list that failed to load says so inside the list (with Try
          again); this line is for everything else. */}
      <ErrorMessage message={data ? error : ""} />
      <SuccessMessage message={success} />

      {summary && (
        <div className="stat-grid">
          <StatTile
            icon="alert-circle"
            tone="danger"
            label="Open"
            value={count(summary.open)}
            note={`${count(summary.in_progress)} more being worked on`}
          />
          <StatTile
            icon="check-circle"
            tone="success"
            label="Resolved"
            value={count(summary.resolved)}
            note={summary.hoursToResolve !== null ? resolveTime(summary.hoursToResolve) : `Of ${count(summary.total)} in all`}
          />
          <StatTile
            icon="gift"
            tone="primary"
            label="Given back this month"
            value={money(summary.compensationMonth, currency)}
            note={`${count(summary.compensated)} complaints with a recorded make-good`}
          />
          <StatTile
            icon="receipt"
            tone="info"
            label="Tied to a bill"
            value={count(summary.linked)}
            note={`Of ${count(summary.total)} complaints`}
          />
        </div>
      )}

      <SectionCard
        icon="clipboard"
        title="Complaint log"
        description={
          data
            ? `${logSummary(data.total, Boolean(search || statusFilter))} Open one to hand it on, record what was given, or close it.`
            : "Open one to hand it on, record what was given, or close it."
        }
        className="crm-list"
        flush
      >
        {data && data.searchLimited && (
          <p className="alert alert-info small crm-masked-note">
            For your role, part of a mobile finds a guest only by its last 4 digits (bill and order numbers are found in
            part). Type the whole number, or just the last 4.
          </p>
        )}

        <DataGrid
          id="crm-complaints"
          caption="Complaint log"
          columns={[
            {
              key: "subject",
              header: "Complaint",
              value: (complaint) => complaint.subject,
              mobile: "title",
              csv: (complaint) => (complaint.resolution ? `${complaint.subject} (resolved: ${complaint.resolution})` : complaint.subject),
              render: (complaint) => (
                <div className="crm-complaint-cell">
                  <strong>{complaint.subject}</strong>
                  <div className="muted small">{CATEGORY_LABELS[complaint.category]}</div>
                  {complaint.resolution && (
                    <div className="small crm-resolution">
                      <Icon name="check" size={13} />
                      <span>Resolved: {complaint.resolution}</span>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "category",
              header: "Category",
              value: (complaint) => CATEGORY_LABELS[complaint.category] || complaint.category,
              defaultHidden: true,
            },
            {
              key: "guest",
              header: "Guest",
              value: (complaint) => complaint.customerName,
              mobile: "show",
              csv: (complaint) =>
                [complaint.customerName, complaint.customerMobile ? formatMobile(complaint.customerMobile) || complaint.customerMobile : null]
                  .filter(Boolean)
                  .join(" · "),
              render: (complaint) => (
                <>
                  {complaint.customerName || <span className="muted">—</span>}
                  {complaint.customerMobile && (
                    <div className="muted small mono nowrap">{formatMobile(complaint.customerMobile) || complaint.customerMobile}</div>
                  )}
                </>
              ),
            },
            {
              key: "bill",
              header: "Bill",
              value: (complaint) => complaint.billNumber || complaint.orderNumber,
              mobile: "show",
              render: (complaint) => (
                <span className="mono small nowrap">
                  {complaint.billNumber || complaint.orderNumber || <span className="muted">—</span>}
                  {complaint.billNumber && complaint.orderNumber && <div className="muted">{complaint.orderNumber}</div>}
                </span>
              ),
            },
            {
              key: "priority",
              header: "Priority",
              type: "status",
              value: (complaint) => complaint.priority,
              csv: (complaint) => PRIORITY_LABELS[complaint.priority] || complaint.priority,
              render: (complaint) => (
                <span className={`badge status-badge badge-priority-${complaint.priority}`}>
                  <Icon name={PRIORITY_ICONS[complaint.priority] || "minus"} size={12} />
                  {PRIORITY_LABELS[complaint.priority]}
                </span>
              ),
            },
            {
              key: "with",
              header: "With",
              value: (complaint) => complaint.assignedToName,
              render: (complaint) => <span className="small nowrap">{complaint.assignedToName || <span className="muted">Nobody yet</span>}</span>,
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (complaint) => complaint.complaintStatus,
              mobile: "subtitle",
              csv: (complaint) => STATUS_LABELS[complaint.complaintStatus] || complaint.complaintStatus,
              render: (complaint) => (
                <span className={`badge status-badge ${statusBadge(complaint.complaintStatus)}`}>
                  <span className="badge-dot" />
                  {STATUS_LABELS[complaint.complaintStatus]}
                </span>
              ),
            },
            {
              key: "madeGood",
              header: "Made good",
              value: (complaint) => (complaint.compensationType ? compensationLabel(complaint.compensationType) : null),
              // Starts hidden so Logged and Update fit at 1440 without a sideways
              // scroll; the Columns menu brings it back.
              defaultHidden: true,
              mobile: "show",
              render: (complaint) =>
                complaint.compensationType ? (
                  <span className="small">
                    {compensationLabel(complaint.compensationType)}
                    {complaint.compensationValue > 0 && <div className="muted">{money(complaint.compensationValue, currency)}</div>}
                  </span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              // What the make-good cost, as a figure of its own for the
              // spreadsheet (and the Columns menu).
              key: "worth",
              header: "Worth",
              type: "money",
              value: (complaint) => (complaint.compensationType && complaint.compensationValue > 0 ? Number(complaint.compensationValue) : null),
              defaultHidden: true,
            },
            {
              key: "logged",
              header: "Logged",
              type: "date",
              value: (complaint) => complaint.createdAt,
              mobile: "show",
              render: (complaint) => <span className="small nowrap">{shortDate(complaint.createdAt)}</span>,
            },
            {
              // How long a still-open complaint has waited; red past a day.
              key: "age",
              header: "Age",
              value: (complaint) => (isOpen(complaint) ? Math.round(hoursOpen(complaint) * 60) : null),
              csv: (complaint) => (isOpen(complaint) ? duration(complaint.createdAt) : ""),
              mobile: "show",
              width: 96,
              render: (complaint) =>
                isOpen(complaint) ? (
                  <span
                    className={`small nowrap ${hoursOpen(complaint) > LATE_HOURS ? "text-danger" : "muted"}`}
                    title={hoursOpen(complaint) > LATE_HOURS ? "Open for more than a day" : undefined}
                  >
                    {hoursOpen(complaint) > LATE_HOURS && <Icon name="clock" size={12} />} {duration(complaint.createdAt)}
                  </span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (complaint) => (
                <div className="row-actions">
                  {isOpen(complaint) && meAssignable && Number(complaint.assignedTo) !== Number(user.id) && (
                    <button
                      type="button"
                      className="link-button crm-row-link"
                      onClick={() => assignToMe(complaint)}
                      disabled={quickBusy === complaint.id}
                    >
                      <Icon name="user" size={15} /> Assign to me
                    </button>
                  )}
                  {isOpen(complaint) && (
                    <button
                      type="button"
                      className="link-button crm-row-link"
                      onClick={() => {
                        setResolution("");
                        setToResolve(complaint);
                      }}
                      disabled={quickBusy === complaint.id}
                    >
                      <Icon name="check" size={15} /> Resolve
                    </button>
                  )}
                  <button type="button" className="link-button crm-row-link" onClick={() => open(complaint)}>
                    <Icon name="edit" size={15} /> Update
                  </button>
                </div>
              ),
            },
          ]}
          rows={items}
          rowKey={(complaint) => complaint.id}
          loading={loading && !data}
          error={data ? "" : error}
          onRetry={load}
          empty={
            statusFilter === STILL_OPEN && !search
              ? "Nothing still open: every complaint is resolved."
              : statusFilter
                ? "No complaint matches these filters."
                : "No complaints logged."
          }
          emptyIcon={statusFilter ? "search" : "check-circle"}
          emptyHint="Log a complaint against the bill it is about, so the amount and the guest are one click away."
          rowNoun={["complaint", "complaints"]}
          currency={currency}
          exportName={canExport ? "complaints" : undefined}
          // The API pages and searches; it does not sort, so the headers do
          // not offer to (sorting 25 of 300 would only look like an answer).
          server={{
            total: data?.total ?? 0,
            page: Math.floor(offset / limit) + 1,
            pageSize: limit,
            fetchAll,
            onChange: ({ page, pageSize }) => {
              setLimit(pageSize);
              setOffsetText(String((page - 1) * pageSize));
            },
          }}
          search={{ value: typed, onChange: setTyped, placeholder: "Subject, guest, mobile or bill" }}
          toolbar={
            <label className="field crm-status-filter">
              <span>Status</span>
              <select
                value={statusParam}
                onChange={(event) => {
                  patch({ status: event.target.value, from: 0 });
                }}
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      </SectionCard>

      {toResolve && (
        <Modal
          title="Resolve complaint"
          icon="check-circle"
          description={`"${toResolve.subject}"${toResolve.customerName ? ` · ${toResolve.customerName}` : ""}`}
          onClose={() => quickBusy !== toResolve.id && setToResolve(null)}
          width={480}
        >
          <form className="form-grid" onSubmit={submitResolve}>
            <label className="field field-wide">
              <span>How it was resolved</span>
              <textarea
                rows={3}
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
                required
                maxLength={1000}
                autoFocus
                placeholder="Called the guest, apologised and sent a fresh biryani"
              />
              <small className="muted">What the guest was given is recorded from Update.</small>
            </label>
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setToResolve(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={quickBusy === toResolve.id || !resolution.trim()}>
                <Icon name="check" size={16} />
                {quickBusy === toResolve.id ? "Saving…" : "Mark resolved"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal
          title={editing.id ? "Update complaint" : "Log a complaint"}
          icon={editing.id ? "edit" : "alert"}
          description={
            editing.id
              ? "Hand it on, record what the guest was given, and close it once it is put right."
              : "What went wrong and which bill it is about. Everything else can be filled in later."
          }
          onClose={() => setEditing(null)}
          width={720}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">The complaint</p>

            <label className="field field-wide">
              <span>What went wrong *</span>
              {/* The cursor starts here only for a new complaint. Updating one is
                  usually a change of status or of who has it, and on a phone
                  a cursor here opens the keyboard over the whole form. */}
              <input
                value={form.subject}
                onChange={change("subject")}
                required
                autoFocus={!editing.id}
                maxLength={200}
                placeholder="Biryani served cold"
              />
            </label>

            <div className="field field-wide crm-reference">
              <label htmlFor="complaint-reference">Bill or order number</label>
              <div className="crm-reference-row">
                <input
                  id="complaint-reference"
                  value={form.reference}
                  onChange={(event) => {
                    setForm({ ...form, reference: event.target.value });
                    setMatch(null);
                    setMatchError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      findReference();
                    }
                  }}
                  placeholder="INV-2891, or just 2891"
                  className="mono"
                  maxLength={40}
                />
                <button type="button" className="button button-secondary" onClick={findReference} disabled={finding || !form.reference.trim()}>
                  <Icon name="search" size={16} />
                  {finding ? "Finding…" : "Find"}
                </button>
              </div>
              {match ? (
                <ReferenceCard match={match} currency={currency} />
              ) : matchError ? (
                <small className="crm-hint-bad">{matchError}</small>
              ) : (
                <small className="muted">
                  From the printed bill. A billing complaint cannot be checked without it; the guest on the bill is linked for you.
                </small>
              )}
            </div>

            {!editing.id && canPickGuest && (
              <GuestPicker
                value={form.guest}
                onChange={(guest) => setForm({ ...form, guest })}
                label="Guest in the book"
                hint="Optional. Found from the bill when it had one."
              />
            )}

            {!form.guest && (
              <>
                <label className="field">
                  <span>Guest's name</span>
                  <input value={form.customerName} onChange={change("customerName")} maxLength={150} disabled={Boolean(editing.id)} />
                </label>
                <label className="field">
                  <span>Mobile, to call them back</span>
                  <input value={form.customerMobile} onChange={change("customerMobile")} inputMode="tel" maxLength={20} />
                  {mobile && !/X/.test(form.customerMobile) ? (
                    <small className={mobile.ok ? "crm-hint-ok" : "crm-hint-bad"}>{mobile.text}</small>
                  ) : (
                    <small className="muted">For a walk-in who is not in the guest book</small>
                  )}
                </label>
              </>
            )}

            <label className="field field-wide">
              <span>What the guest said</span>
              <textarea rows={3} value={form.description} onChange={change("description")} maxLength={1000} />
            </label>

            <p className="section-heading field-wide">Who handles it</p>

            <label className="field">
              <span>Category</span>
              <select value={form.category} onChange={change("category")}>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Priority</span>
              <select value={form.priority} onChange={change("priority")}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>

            <label className="field">
              <span>Hand it to</span>
              <select value={form.assignedTo} onChange={change("assignedTo")}>
                <option value="">Nobody yet</option>
                {editing.id && editing.assignedTo && !staff.some((member) => member.id === editing.assignedTo) && (
                  <option value={String(editing.assignedTo)}>{editing.assignedToName} (no longer active)</option>
                )}
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                    {member.roles ? ` · ${member.roles}` : ""}
                  </option>
                ))}
              </select>
            </label>

            {editing.id && (
              <label className="field">
                <span>Status</span>
                <select value={form.complaintStatus} onChange={change("complaintStatus")}>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <fieldset className="field field-wide crm-fieldset">
              <legend className="section-heading">What the guest was given to put it right</legend>
              <div className="crm-three">
                <label className="field">
                  <span>Given</span>
                  <select value={form.compensationType} onChange={change("compensationType")}>
                    <option value="">Nothing yet</option>
                    {COMPENSATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Worth ({currency})</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={costs ? form.compensationValue : ""}
                    onChange={change("compensationValue")}
                    disabled={!costs}
                    placeholder={costs ? "180" : "—"}
                  />
                </label>
                <label className="field">
                  <span>Details</span>
                  <input
                    value={form.compensationNotes}
                    onChange={change("compensationNotes")}
                    disabled={!form.compensationType}
                    maxLength={300}
                    placeholder="Gulab jamun on the house"
                  />
                </label>
              </div>
              <small className="muted">
                A record of what it cost. The refund itself is given from Bills, points from the guest's card.
              </small>
            </fieldset>

            {editing.id && resolving && (
              <label className="field field-wide">
                <span>How it was resolved *</span>
                <textarea rows={2} value={form.resolution} onChange={change("resolution")} required maxLength={1000} />
              </label>
            )}

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                <Icon name="check" size={16} />
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
