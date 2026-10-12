import { useCallback, useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  createLeaveType,
  deleteLeaveType,
  getLeaveRegister,
  listLeaveTypes,
  updateLeaveType,
} from "../services/staff.service";
import { getErrorMessage } from "../../../../services/api";
import { today } from "../../../../services/dates";
import { escapeHtml, printDocument } from "../../../../services/print";

// Employees -> Leave: the leave types the owner sets (Casual 1 a month, Sick
// 6 a year, Unpaid), and everyone's leave record: allowance, taken, left.
// Leave inside the allowance is paid; over it, and Unpaid leave, is loss of
// pay on Payroll.

const PERIOD_WORDS = { month: "a month", year: "a year" };

const days = (value) => (value === null || value === undefined ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(1));

const EMPTY = {
  name: "",
  paid: true,
  allowanceDays: "1",
  allowancePeriod: "month",
  carryForward: false,
  isDefault: false,
  status: "active",
};

const dateWords = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export default function LeavePanel({ canManage, restaurantName }) {
  const [types, setTypes] = useState(null);
  const [register, setRegister] = useState(null);
  const [date, setDate] = useState(today());
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [person, setPerson] = useState(null);

  const load = useCallback(
    () =>
      Promise.all([listLeaveTypes(), getLeaveRegister(date)])
        .then(([typeRows, registerData]) => {
          setTypes(typeRows);
          setRegister(registerData);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [date]
  );

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = (type) => {
    setForm(
      type
        ? {
            name: type.name,
            paid: type.paid,
            allowanceDays: type.allowanceDays === null ? "" : String(type.allowanceDays),
            allowancePeriod: type.allowancePeriod,
            carryForward: type.carryForward,
            isDefault: type.isDefault,
            status: type.status,
          }
        : { ...EMPTY, isDefault: !types || types.length === 0 }
    );
    setFormError("");
    setEditing(type || {});
  };

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      ...form,
      allowanceDays: form.paid ? Number(form.allowanceDays || 0) : null,
      carryForward: form.paid ? form.carryForward : false,
      ...(editing.id ? { countsFrom: editing.countsFrom } : {}),
    };

    try {
      if (editing.id) {
        await updateLeaveType(editing.id, payload);
        setSuccess(`${form.name} saved`);
      } else {
        await createLeaveType(payload);
        setSuccess(`${form.name} added. Leave marked on the roster or the sheet now asks for its type.`);
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);

    try {
      await deleteLeaveType(deleting.id);
      setSuccess(`${deleting.name} deleted`);
      setDeleting(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  // Everyone's record (or one person's), on the restaurant's printer.
  const print = (people) => {
    const active = register.types;
    const rows = people
      .map(
        (row) => `<tr><td><b>${escapeHtml(row.name)}</b>${row.employeeCode ? ` <span class="m">${escapeHtml(row.employeeCode)}</span>` : ""}</td>${active
          .map((type) => {
            const cell = row.types.find((item) => item.typeId === type.id);
            return `<td>${cell ? (cell.paid ? `${days(cell.taken)} / ${days(cell.available)} · <b>${days(Math.max(0, cell.left))} left</b>${cell.unpaid ? ` · ${cell.unpaid} unpaid` : ""}` : `${days(cell.taken)} taken`) : "—"}</td>`;
          })
          .join("")}</tr>`
      )
      .join("");

    printDocument({
      title: people.length === 1 ? `Leave record ${people[0].name}` : "Leave record",
      styles: `
        @page { size: A4 landscape; margin: 12mm; }
        body { font-family: system-ui, sans-serif; font-size: 11px; color: #111; }
        h1 { font-size: 16px; margin: 0; } .m { color: #555; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #bbb; padding: 5px 6px; text-align: left; vertical-align: top; }
        th { background: #f1f1f1; }
        .sign { margin-top: 36px; display: flex; justify-content: space-between; }
      `,
      body: `
        <h1>${escapeHtml(restaurantName || "")} · Leave record</h1>
        <div class="m">As on ${escapeHtml(dateWords(register.date))} · taken / allowed this period, and what is left</div>
        <table>
          <thead><tr><th>Employee</th>${active
            .map((type) => `<th>${escapeHtml(type.name)}${type.paid ? ` (${days(type.allowanceDays)} ${PERIOD_WORDS[type.allowancePeriod]}${type.carryForward ? ", carried" : ""})` : " (unpaid)"}</th>`)
            .join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="sign"><span>Prepared by</span><span>Approved by</span></div>
      `,
    });
  };

  if (!types || !register) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Loading leave…" />;
  }

  const activeTypes = register.types;

  return (
    <div className="stack">
      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <SectionCard
        icon="calendar"
        title="Leave types"
        description="Paid leave up to the allowance; days over it, and Unpaid leave, are loss of pay. Leave marked without a type counts against the default."
        actions={
          canManage && (
            <button type="button" className="button button-sm" onClick={() => openEdit(null)}>
              <Icon name="plus" size={15} /> Add leave type
            </button>
          )
        }
        flush
      >
        <DataGrid
          id="leave-types"
          caption="Leave types"
          columns={[
            {
              key: "name",
              header: "Leave type",
              value: (type) => type.name,
              mobile: "title",
              pin: true,
              render: (type) => (
                <span className="acc-who-text">
                  <strong>
                    {type.name}
                    {type.isDefault && <span className="tag asw-default-tag">Default</span>}
                  </strong>
                  <span className="muted small">{type.paid ? "Paid leave" : "Unpaid — loss of pay"}</span>
                </span>
              ),
            },
            {
              key: "allowance",
              header: "Allowance",
              value: (type) =>
                type.paid ? `${days(type.allowanceDays)} day${type.allowanceDays === 1 ? "" : "s"} ${PERIOD_WORDS[type.allowancePeriod]}` : "",
              mobile: "show",
            },
            {
              key: "unused",
              header: "Unused days",
              value: (type) => (type.paid ? (type.carryForward ? "Carried forward" : "Lapse at the end") : ""),
              mobile: "show",
            },
            { key: "usedDays", header: "Days marked", type: "number", value: (type) => type.usedDays, mobile: "show" },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (type) => type.status,
              mobile: "subtitle",
              render: (type) => <StatusBadge status={type.status} />,
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (type) => (
                <div className="row-actions">
                  <button type="button" className="chip-button" onClick={() => openEdit(type)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <ActionMenu
                    label={`More for ${type.name}`}
                    items={[{ label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(type) }]}
                  />
                </div>
              ),
            },
          ]}
          rows={types}
          rowKey={(type) => type.id}
          empty="No leave types yet"
          emptyIcon="calendar"
          emptyHint="Until you add them, all leave follows the old Payroll setting (paid or not, without limit). Add Casual, Sick and Unpaid to pay leave only up to an allowance."
          emptyAction={
            canManage ? (
              <button type="button" className="button" onClick={() => openEdit(null)}>
                <Icon name="plus" size={15} /> Add leave type
              </button>
            ) : null
          }
          rowClassName={(type) => (type.status === "active" ? "" : "dg-tone-muted")}
          pageSize={false}
        />
      </SectionCard>

      {activeTypes.length > 0 && (
        <SectionCard
          icon="users"
          title="Leave record"
          description="Each person's leave this month (monthly types) or this year (yearly types): taken out of what was allowed, and what is left. Tap a name for their record."
          actions={
            <div className="asw-inline-actions">
              <label className="asw-date-chip">
                <span className="sr-only">As on</span>
                <input type="date" value={date} onChange={(event) => setDate(event.target.value || today())} />
              </label>
              <button type="button" className="button button-secondary button-sm" onClick={() => print(register.people)} disabled={register.people.length === 0}>
                <Icon name="print" size={15} /> Print
              </button>
            </div>
          }
          flush
        >
          <DataGrid
            id="leave-record"
            caption="Leave record"
            columns={[
              {
                key: "name",
                header: "Employee",
                value: (row) => row.name,
                mobile: "title",
                pin: true,
                render: (row) => (
                  <>
                    <button type="button" className="link-button asw-person-link" onClick={() => setPerson(row)}>
                      {row.name}
                    </button>
                    {row.designation && <div className="muted small">{row.designation}</div>}
                  </>
                ),
              },
              ...activeTypes.map((type) => {
                const cellOf = (row) => row.types.find((item) => item.typeId === type.id);

                return {
                  key: `type-${type.id}`,
                  header: (
                    <>
                      {type.name}
                      <small className="muted asw-leave-head-note">
                        {type.paid ? `${days(type.allowanceDays)} ${PERIOD_WORDS[type.allowancePeriod]}` : "unpaid"}
                      </small>
                    </>
                  ),
                  label: type.name,
                  type: "number",
                  align: "left",
                  mobile: "show",
                  // Sorted and exported by the days left (paid types) or taken (unpaid).
                  value: (row) => {
                    const cell = cellOf(row);
                    return cell ? (cell.paid ? Math.max(0, cell.left ?? 0) : cell.taken || 0) : null;
                  },
                  csv: (row) => {
                    const cell = cellOf(row);
                    return !cell
                      ? ""
                      : cell.paid
                        ? `${days(Math.max(0, cell.left ?? 0))} left (${days(cell.taken)} of ${days(cell.available)} taken${cell.unpaid ? `, ${cell.unpaid} unpaid` : ""})`
                        : `${cell.taken || 0} taken`;
                  },
                  render: (row) => {
                    const cell = cellOf(row);

                    if (!cell) {
                      return <span className="muted">—</span>;
                    }

                    const left = Math.max(0, cell.left ?? 0);

                    return cell.paid ? (
                      <span className="asw-balance">
                        <span className={`asw-balance-left ${left < 1 ? "is-empty" : ""}`}>{days(left)} left</span>
                        <span className="muted small">
                          {days(cell.taken)} of {days(cell.available)} taken
                          {cell.unpaid ? ` · ${cell.unpaid} unpaid` : ""}
                        </span>
                      </span>
                    ) : (
                      <span className="muted small">{cell.taken ? `${cell.taken} taken` : "—"}</span>
                    );
                  },
                };
              }),
            ]}
            rows={register.people}
            rowKey={(row) => row.employeeId}
            empty="No active employees"
            emptyIcon="users"
            emptyHint="Leave records list everyone marked active."
            exportName="leave-record"
          />
        </SectionCard>
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : "Add leave type"}
          description="How many paid days, per month or per year, and what happens to days not taken."
          icon="calendar"
          onClose={() => setEditing(null)}
          width={520}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <label className="field field-wide">
              <span>Name *</span>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required autoFocus maxLength={40} placeholder="Casual" />
            </label>

            <div className="field field-wide">
              <span>Pay</span>
              <div className="segmented" role="radiogroup" aria-label="Paid or unpaid">
                {[
                  [true, "Paid, up to an allowance"],
                  [false, "Unpaid (loss of pay)"],
                ].map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={form.paid === value}
                    className={`segment ${form.paid === value ? "is-active" : ""}`}
                    onClick={() => setForm({ ...form, paid: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {form.paid && (
              <>
                <label className="field">
                  <span>Allowance (days) *</span>
                  <input
                    type="number"
                    min="0"
                    max="366"
                    step="0.5"
                    value={form.allowanceDays}
                    onChange={(event) => setForm({ ...form, allowanceDays: event.target.value })}
                    required
                  />
                </label>
                <label className="field">
                  <span>Per</span>
                  <select value={form.allowancePeriod} onChange={(event) => setForm({ ...form, allowancePeriod: event.target.value })}>
                    <option value="month">Month</option>
                    <option value="year">Year (January to December)</option>
                  </select>
                </label>
                <label className="checkbox field-wide">
                  <input type="checkbox" checked={form.carryForward} onChange={(event) => setForm({ ...form, carryForward: event.target.checked })} />
                  <span>Unused days carry forward to the next {form.allowancePeriod}</span>
                </label>
              </>
            )}

            <label className="checkbox field-wide">
              <input type="checkbox" checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />
              <span>Default: leave marked without a type counts as this</span>
            </label>

            {editing.id && (
              <label className="field">
                <span>Status</span>
                <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
            )}

            <p className="muted small field-wide">
              A yearly allowance for someone who joins part-way through a year is the share of the year left (July: half).
              Changing an allowance changes what is still unpaid; pay already marked paid keeps its figures.
            </p>

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

      {deleting && (
        <ConfirmDialog
          title="Delete leave type"
          message={`Delete "${deleting.name}"? A type already used on the roster or the sheet cannot be deleted — set it to inactive instead.`}
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}

      {person && (
        <Modal title={`Leave record — ${person.name}`} description={`As on ${dateWords(register.date)}.`} icon="user" onClose={() => setPerson(null)} width={560}>
          <div className="stack">
            <ul className="asw-share-rows">
              {person.types.map((cell) => (
                <li key={cell.typeId}>
                  <span>
                    <strong>{cell.name}</strong>
                    <small className="muted">
                      {cell.paid
                        ? `${cell.periodLabel}: ${days(cell.allowance)} allowed${cell.carriedIn ? ` + ${days(cell.carriedIn)} carried in` : ""} · ${days(cell.taken)} taken${cell.unpaid ? ` (${cell.unpaid} unpaid)` : ""}`
                        : `${cell.periodLabel}: ${days(cell.taken)} taken, all unpaid`}
                    </small>
                  </span>
                  <strong className="asw-share-amount">{cell.paid ? `${days(Math.max(0, cell.left))} left` : "—"}</strong>
                </li>
              ))}
            </ul>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => print([person])}>
                <Icon name="print" size={15} /> Print
              </button>
              <button type="button" className="button" onClick={() => setPerson(null)}>
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
