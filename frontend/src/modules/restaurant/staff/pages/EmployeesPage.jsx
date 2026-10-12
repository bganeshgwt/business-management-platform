import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatusBadge from "../../../../components/StatusBadge";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import FormField from "../../../../components/FormField";
import {
  createEmployee,
  deleteEmployee,
  getSalaryHistory,
  listEmployees,
  updateEmployee,
} from "../services/staff.service";
import { listUsers } from "../../../access/services/user.service";
import { listPins, removePin, unlockPin } from "../services/timeclock.service";
import { listOutlets } from "../../../../services/outlet.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { count, dateShort, money, moneyExact } from "../../../../services/format";
import { today } from "../../../../services/dates";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import LeavePanel from "./LeavePanel";
import ClockPinModal from "./ClockPinModal";
import "../../../../styles/access.css";
import "../../../../styles/access-sweep.css";

const DEPARTMENTS = {
  kitchen: "Kitchen",
  service: "Service",
  management: "Management",
  delivery: "Delivery",
  housekeeping: "Housekeeping",
  other: "Other",
};

const SALARY_TYPES = { monthly: "Per month", daily: "Per day", hourly: "Per hour" };

// "1 Sep 2026" for a date string, whatever the browser's clock.
const dayText = (value) => (value ? dateShort(String(value).slice(0, 10), { year: true }) : "");

// Every raise already dated for later, oldest first.
const plannedOf = (employee) =>
  employee.plannedSalaries || (employee.upcomingSalary ? [employee.upcomingSalary] : []);

// The salary last entered for someone: the LAST raise planned for a later
// date when there is one (what the server keeps as their salary), else the
// salary in force today. The form starts from it and is compared with it; a
// save that leaves it alone sends no salary at all, so the planned raises
// stay exactly as they are. Starting from the first planned raise instead is
// how saving a name began October's raise today and deleted November's.
const savedSalary = (employee) => {
  const planned = plannedOf(employee);

  return planned.length > 0
    ? planned[planned.length - 1]
    : { salaryType: employee.salaryType, salaryAmount: employee.salaryAmount };
};

// "Rises to ₹45,000 from 1 Oct 2026" — each planned line against the one
// before it (today's salary for the first).
const plannedWords = (line, before, currency) =>
  `${line.salaryType === before.salaryType && line.salaryAmount > before.salaryAmount ? "Rises" : "Changes"} to ${money(
    line.salaryAmount,
    currency
  )}${line.salaryType !== before.salaryType ? ` ${SALARY_TYPES[line.salaryType]?.toLowerCase()}` : ""} from ${dayText(
    line.from
  )}`;

const EMPTY = {
  name: "",
  employeeCode: "",
  mobile: "",
  email: "",
  designation: "",
  department: "service",
  employmentType: "full_time",
  salaryType: "monthly",
  salaryAmount: "",
  // When a changed salary starts; blank means today.
  salaryEffectiveFrom: "",
  dateOfJoining: "",
  dateOfLeaving: "",
  outletId: "",
  userId: "",
  address: "",
  emergencyContact: "",
  notes: "",
  status: "active",
  // Optional; some states' professional tax treats women differently.
  gender: "",
  // PF, ESI and professional tax (seen and set only with salaries).
  pfApplicable: false,
  esiApplicable: false,
  ptApplicable: true,
  uan: "",
  esiNumber: "",
  basicPercent: "100",
  // Salary bank account, for Payroll's "Export for bank" sheet.
  bankAccountName: "",
  bankAccountNumber: "",
  bankIfsc: "",
};

export default function EmployeesPage() {
  const { user, hasPermission } = useAuth();
  const [tab, setTab] = useQueryFilter("tab", "list");
  const canManage = hasPermission("staff.manage");
  // Salaries are private: without this the column and the fields are not
  // shown at all (the server leaves the amounts out too).
  const canSeePay = hasPermission("staff.salaries");

  const [employees, setEmployees] = useState([]);
  const [users, setUsers] = useState([]);
  // Time-clock PIN state per employee, for the badge in the list.
  const [pins, setPins] = useState({});
  const [outlets, setOutlets] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  // The person's salary lines, loaded when their record is opened.
  const [salaryHistory, setSalaryHistory] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // The person whose clock PIN is being set or reset, and the one whose PIN is
  // about to be removed.
  const [pinEditing, setPinEditing] = useState(null);
  const [pinRemoving, setPinRemoving] = useState(null);

  const refreshPins = useCallback(
    () =>
      listPins()
        .then((data) => setPins(Object.fromEntries(data.items.map((row) => [row.id, row]))))
        .catch(() => setPins({})),
    []
  );

  const load = useCallback(
    () =>
      listEmployees({ department: department || undefined, search: search.trim() || undefined })
        .then(setEmployees)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [department, search]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Optional extras: the page works without them, so each is only asked for
    // by someone who may see it.
    if (hasPermission("users.view")) {
      listUsers()
        .then(setUsers)
        .catch(() => setUsers([]));
    }

    if (hasPermission("outlets.view")) {
      listOutlets()
        .then(setOutlets)
        .catch(() => setOutlets([]));
    }

    if (hasPermission("staff.manage")) {
      listPins()
        .then((data) => setPins(Object.fromEntries(data.items.map((row) => [row.id, row]))))
        .catch(() => setPins({}));
    }

    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, [hasPermission]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  // A changed salary on an existing person starts on a date: the days before
  // keep the old salary, so months already worked or paid are not re-priced.
  const saved = editing && editing.id ? savedSalary(editing) : null;
  const salaryChanged = Boolean(
    saved &&
      canSeePay &&
      (form.salaryType !== saved.salaryType ||
        Math.abs(Number(form.salaryAmount || 0) - Number(saved.salaryAmount || 0)) >= 0.005)
  );
  const earliestNewSalary = salaryHistory && salaryHistory.earliestNewSalary;
  // Someone who has only ever been on ₹0 (added by a supervisor who cannot
  // see pay, say): the salary entered now is owed from the day they joined,
  // not from today, unless another date is picked.
  const firstSalaryFrom = salaryHistory && Number(form.salaryAmount || 0) > 0 ? salaryHistory.firstSalaryFrom : null;
  const salaryFromShown = form.salaryEffectiveFrom || firstSalaryFrom || today();
  // Raises already planned for this person, and which of them a changed
  // salary would replace: the server keeps the days before its start date
  // and replaces everything from that date on.
  const planned = editing && editing.id && canSeePay ? plannedOf(editing) : [];
  const replaced = salaryChanged ? planned.filter((line) => line.from >= salaryFromShown) : [];
  // The line in force today: the latest one that has started.
  const currentSalaryLine = salaryHistory
    ? ([...salaryHistory.items].reverse().find((line) => line.from <= today()) || salaryHistory.items[0] || {}).id
    : null;

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    // The salary goes with a new person, or with an edit only when it was
    // changed on purpose. Left out, the server keeps it as it is, planned
    // raises included. Someone who cannot see pay never sends it.
    const sendSalary = canSeePay && (!editing.id || salaryChanged);
    const payload = {
      ...form,
      salaryAmount: sendSalary ? Number(form.salaryAmount || 0) : undefined,
      salaryType: sendSalary ? form.salaryType : undefined,
      // Only a date someone picked. Without one the server decides, on the
      // restaurant's own calendar: today for a raise, the joining date for
      // a first salary.
      salaryEffectiveFrom: salaryChanged && form.salaryEffectiveFrom ? form.salaryEffectiveFrom : undefined,
      outletId: form.outletId ? Number(form.outletId) : null,
      userId: form.userId ? Number(form.userId) : null,
      employeeCode: form.employeeCode || null,
      email: form.email || null,
      dateOfJoining: form.dateOfJoining || null,
      dateOfLeaving: form.dateOfLeaving || null,
      gender: form.gender || null,
      // Sent only by someone who may see pay; otherwise left as they are.
      pfApplicable: canSeePay ? form.pfApplicable : undefined,
      esiApplicable: canSeePay ? form.esiApplicable : undefined,
      ptApplicable: canSeePay ? form.ptApplicable : undefined,
      uan: canSeePay ? form.uan.trim() || null : undefined,
      esiNumber: canSeePay ? form.esiNumber.trim() || null : undefined,
      basicPercent: canSeePay ? Number(form.basicPercent || 100) : undefined,
      bankAccountName: canSeePay ? form.bankAccountName.trim() || null : undefined,
      bankAccountNumber: canSeePay ? form.bankAccountNumber.replace(/[\s-]/g, "") || null : undefined,
      bankIfsc: canSeePay ? form.bankIfsc.replace(/\s/g, "").toUpperCase() || null : undefined,
    };

    try {
      if (editing.id) {
        await updateEmployee(editing.id, payload);
        setSuccess("Employee updated");
      } else {
        await createEmployee(payload);
        setSuccess("Employee added");
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
      await deleteEmployee(deleting.id);
      setDeleting(null);
      setSuccess("Employee removed");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (employee) => {
    const salary = savedSalary(employee);

    setForm({
      name: employee.name,
      employeeCode: employee.employeeCode || "",
      mobile: employee.mobile || "",
      email: employee.email || "",
      designation: employee.designation || "",
      department: employee.department,
      employmentType: employee.employmentType,
      salaryType: salary.salaryType || "monthly",
      salaryAmount: salary.salaryAmount === null || salary.salaryAmount === undefined ? "" : String(salary.salaryAmount),
      salaryEffectiveFrom: "",
      dateOfJoining: employee.dateOfJoining || "",
      dateOfLeaving: employee.dateOfLeaving || "",
      outletId: employee.outletId ? String(employee.outletId) : "",
      userId: employee.userId ? String(employee.userId) : "",
      address: employee.address || "",
      emergencyContact: employee.emergencyContact || "",
      notes: employee.notes || "",
      status: employee.status,
      gender: employee.gender || "",
      pfApplicable: Boolean(employee.pfApplicable),
      esiApplicable: Boolean(employee.esiApplicable),
      ptApplicable: employee.ptApplicable !== false,
      uan: employee.uan || "",
      esiNumber: employee.esiNumber || "",
      basicPercent: String(employee.basicPercent ?? 100),
      bankAccountName: employee.bankAccountName || "",
      bankAccountNumber: employee.bankAccountNumber || "",
      bankIfsc: employee.bankIfsc || "",
    });
    setFormError("");
    setSalaryHistory(null);
    setEditing(employee);

    if (canSeePay) {
      getSalaryHistory(employee.id)
        .then(setSalaryHistory)
        .catch(() => setSalaryHistory(null));
    }
  };

  const pinBadge = (employee) => {
    const pin = pins[employee.id];

    if (pin?.lockedUntil) {
      return (
        <span className="badge badge-danger status-badge">
          <span className="badge-dot" aria-hidden="true" />
          Locked
        </span>
      );
    }

    if (pin?.hasPin) {
      return (
        <span className="badge badge-active status-badge">
          <span className="badge-dot" aria-hidden="true" />
          PIN set
        </span>
      );
    }

    return employee.status === "active" ? (
      <span className="badge badge-warning status-badge">
        <span className="badge-dot" aria-hidden="true" />
        No PIN
      </span>
    ) : (
      <span className="muted small">—</span>
    );
  };

  // What the PIN dialogs need about a person.
  const pinRow = (employee) => ({
    id: employee.id,
    name: employee.name,
    mobile: employee.mobile,
    hasPin: Boolean(pins[employee.id]?.hasPin),
    lockedUntil: pins[employee.id]?.lockedUntil || null,
  });

  const pinCell = (employee) => {
    const row = pinRow(employee);
    let action = null;

    if (employee.status === "active") {
      action = row.lockedUntil
        ? { label: "Unlock", icon: "unlock", onClick: () => unlockFor(row) }
        : { label: row.hasPin ? "Reset" : "Set PIN", icon: "key", onClick: () => setPinEditing(row) };
    }

    return (
      <div className="emp-pin-cell">
        {pinBadge(employee)}
        {action && (
          <button
            type="button"
            className="chip-button emp-pin-action"
            onClick={action.onClick}
            aria-label={`${action.label === "Set PIN" ? "Set clock PIN" : `${action.label} clock PIN`} for ${employee.name}`}
          >
            <Icon name={action.icon} size={13} /> {action.label}
          </button>
        )}
      </div>
    );
  };

  const pinMenuItems = (employee) => {
    if (employee.status !== "active") {
      return [];
    }

    const row = pinRow(employee);

    return [
      { label: row.hasPin ? "Reset clock PIN" : "Set clock PIN", icon: "key", onClick: () => setPinEditing(row) },
      row.lockedUntil ? { label: "Unlock clock PIN", icon: "unlock", onClick: () => unlockFor(row) } : null,
      row.hasPin ? { label: "Remove clock PIN", icon: "ban", onClick: () => setPinRemoving(row) } : null,
    ].filter(Boolean);
  };

  const unlockFor = async (row) => {
    setError("");
    setSuccess("");

    try {
      const result = await unlockPin(row.id);
      setSuccess(result.message || `${row.name} can use the time clock again.`);
      refreshPins();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const confirmRemovePin = async () => {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const result = await removePin(pinRemoving.id);
      setSuccess(result.message || `${pinRemoving.name}'s clock PIN is removed.`);
      setPinRemoving(null);
      refreshPins();
    } catch (err) {
      setError(getErrorMessage(err));
      setPinRemoving(null);
    } finally {
      setSaving(false);
    }
  };

  const openNew = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="user-plus" size={16} /> Add employee
    </button>
  );

  // The figures above the list are the list's own: with a department or a
  // search picked they describe what is shown, and say so.
  const filtered = Boolean(department || search.trim());
  const active = employees.filter((employee) => employee.status === "active");
  const byDepartment = Object.entries(
    active.reduce((sum, employee) => ({ ...sum, [employee.department]: (sum[employee.department] || 0) + 1 }), {})
  ).sort((a, b) => b[1] - a[1]);
  const departmentNote =
    byDepartment.length === 0
      ? "nobody active"
      : byDepartment
          .slice(0, 2)
          .map(([key, total]) => `${total} ${DEPARTMENTS[key]?.toLowerCase() || key}`)
          .join(" · ") +
        (byDepartment.length > 2
          ? ` · ${byDepartment.slice(2).reduce((sum, [, total]) => sum + total, 0)} other`
          : "");
  const withoutPin = active.filter((employee) => !pins[employee.id]?.hasPin).length;
  const lockedPins = employees.filter((employee) => pins[employee.id]?.lockedUntil).length;
  const withLogin = employees.filter((employee) => employee.userId).length;
  const monthly = active.filter((employee) => employee.salaryType === "monthly");
  const monthlyTotal = monthly.reduce((sum, employee) => sum + Number(employee.salaryAmount || 0), 0);
  const onWages = active.length - monthly.length;

  const initials = (name) =>
    String(name || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="users"
        title="Employees"
        description="Everyone who works here, with or without a login. Rosters, attendance, the time clock and payroll all start from this list."
        action={addButton}
      />

      <div className="acc-tabs" role="tablist" aria-label="Employees sections" data-motion-tabs>
        {[
          { key: "list", label: "Staff list", icon: "users" },
          { key: "leave", label: "Leave", icon: "calendar" },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`acc-tab ${tab === item.key ? "is-active" : ""}`}
            onClick={() => setTab(item.key)}
          >
            <Icon name={item.icon} size={16} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === "leave" && <LeavePanel canManage={canManage} restaurantName={user.restaurantName} />}

      {tab !== "leave" && (
        <>
      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && employees.length > 0 && (
        <div className="stat-grid">
          <StatTile
            icon="users"
            tone="primary"
            label={filtered ? "Active in this list" : "Active staff"}
            value={count(active.length)}
            note={
              employees.length > active.length
                ? `${departmentNote} · ${employees.length - active.length} inactive`
                : departmentNote
            }
          />
          {canManage && (
            <StatTile
              icon="key"
              tone={lockedPins > 0 ? "danger" : withoutPin > 0 ? "warning" : "success"}
              label="Time-clock PIN"
              value={count(active.length - withoutPin)}
              of={`/${count(active.length)}`}
              note={
                lockedPins > 0
                  ? `${lockedPins} locked after wrong tries`
                  : withoutPin > 0
                    ? `${withoutPin} cannot clock in yet`
                    : "everyone can clock in"
              }
            />
          )}
          <StatTile
            icon="login"
            tone="info"
            label="Can sign in"
            value={count(withLogin)}
            note={withLogin === employees.length ? "every person has a login" : "the rest only use the time clock"}
          />
          {canSeePay && (
            <StatTile
              icon="wallet"
              tone="neutral"
              label="Monthly salaries"
              value={money(monthlyTotal, currency)}
              note={`${monthly.length} on a monthly salary${onWages ? ` · ${onWages} on daily or hourly wages` : ""}`}
            />
          )}
        </div>
      )}

      <SectionCard
        icon="list"
        title="Staff list"
        description={
          canManage
            ? "Edit opens a person's details, pay and linked login. Someone who has left is set to inactive, so their history stays."
            : "Everyone on the staff list, with how they sign in."
        }
        actions={
          !loading &&
          employees.length > 0 && (
            <span className="acc-count">
              {count(employees.length)} {employees.length === 1 ? "person" : "people"}
            </span>
          )
        }
        flush
      >
        <DataGrid
          id="staff-list"
          caption="Staff list"
          columns={[
            {
              key: "name",
              header: "Employee",
              value: (employee) => employee.name,
              mobile: "title",
              pin: true,
              csv: (employee) => (employee.employeeCode ? `${employee.name} (${employee.employeeCode})` : employee.name),
              render: (employee) => (
                <div className="acc-who">
                  <span className="acc-avatar" aria-hidden="true">
                    {initials(employee.name)}
                  </span>
                  <span className="acc-who-text">
                    <strong>{employee.name}</strong>
                    {employee.employeeCode && <span className="muted small mono">{employee.employeeCode}</span>}
                  </span>
                </div>
              ),
            },
            {
              key: "role",
              header: "Role",
              value: (employee) => employee.designation || DEPARTMENTS[employee.department],
              mobile: "subtitle",
              csv: (employee) =>
                employee.designation ? `${employee.designation} (${DEPARTMENTS[employee.department]})` : DEPARTMENTS[employee.department],
              render: (employee) => (
                <>
                  {employee.designation || DEPARTMENTS[employee.department]}
                  {employee.designation && <div className="muted small">{DEPARTMENTS[employee.department]}</div>}
                </>
              ),
            },
            {
              key: "contact",
              header: "Contact",
              value: (employee) => [employee.mobile, employee.email].filter(Boolean).join(" · "),
              mobile: "show",
              render: (employee) => (
                <span className="small">
                  {employee.mobile || "—"}
                  {employee.email && <span className="muted acc-block">{employee.email}</span>}
                </span>
              ),
            },
            canSeePay && {
              key: "salary",
              header: "Salary",
              type: "money",
              value: (employee) => employee.salaryAmount,
              mobile: "show",
              csv: (employee) => `${employee.salaryAmount} ${SALARY_TYPES[employee.salaryType] || ""}`.trim(),
              render: (employee) => (
                <span className="acc-salary-cell">
                  <strong>{money(employee.salaryAmount, currency)}</strong>
                  <span className="muted small acc-block">{SALARY_TYPES[employee.salaryType]}</span>
                  {/* Today's salary above; every raise already dated for later, here. */}
                  {plannedOf(employee).length > 0 && (
                    <span className="acc-salary-plan">
                      {plannedOf(employee).map((line, index, all) => (
                        <span key={line.from} className="acc-salary-next">
                          {plannedWords(line, index === 0 ? employee : all[index - 1], currency)}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "login",
              header: "Login",
              value: (employee) => (employee.userId ? employee.loginName || "Linked" : ""),
              csv: (employee) => (employee.userId ? employee.loginEmail || employee.loginMobile || employee.loginName || "Linked" : ""),
              render: (employee) =>
                employee.userId ? (
                  <span className="small">
                    {employee.loginName || "Linked"}
                    <span className="muted acc-block">{employee.loginEmail || employee.loginMobile}</span>
                  </span>
                ) : (
                  <span className="muted small">No login</span>
                ),
            },
            canManage && {
              key: "clockPin",
              header: <span title="The PIN they use on the staff time clock">Clock PIN</span>,
              label: "Clock PIN",
              mobile: "show",
              value: (employee) => (pins[employee.id]?.lockedUntil ? "Locked" : pins[employee.id]?.hasPin ? "Set" : "Not set"),
              render: (employee) => pinCell(employee),
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (employee) => employee.status,
              mobile: "show",
              render: (employee) => <StatusBadge status={employee.status} />,
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (employee) => (
                // Edit is the everyday one; Delete sits behind the menu, away from it.
                <div className="row-actions">
                  <button type="button" className="chip-button" onClick={() => openEdit(employee)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <ActionMenu
                    label={`More actions for ${employee.name}`}
                    items={[
                      ...pinMenuItems(employee),
                      { label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(employee) },
                    ]}
                  />
                </div>
              ),
            },
          ]}
          rows={employees}
          rowKey={(employee) => employee.id}
          loading={loading}
          empty={filtered ? "Nobody matches" : "No employees yet"}
          emptyIcon={filtered ? "search" : "users"}
          emptyHint={
            filtered
              ? "Check the spelling or the employee code, or show every department."
              : "Add everyone who works here — cooks, captains, riders — even if they never sign in. Shifts, attendance and payroll need them first."
          }
          emptyAction={
            filtered ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setDepartment("");
                  setSearch("");
                }}
              >
                Clear filters
              </button>
            ) : (
              addButton
            )
          }
          rowClassName={(employee) => (employee.status === "active" ? "" : "dg-tone-muted")}
          // The list comes back from the server already searched (name or
          // employee code) and filtered by department.
          search={{ value: search, placeholder: "Name or code", onChange: setSearch }}
          toolbar={
            <label className="field">
              <span>Department</span>
              <select value={department} onChange={(event) => setDepartment(event.target.value)}>
                <option value="">All</option>
                {Object.entries(DEPARTMENTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          }
          exportName="staff-list"
        />
      </SectionCard>
        </>
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : "Add employee"}
          description={
            editing.id
              ? "Changes apply from now on. A changed salary asks from which date."
              : "Only the name is needed now; the rest can be filled in later."
          }
          icon={editing.id ? "user" : "user-plus"}
          onClose={() => setEditing(null)}
          width={680}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">Who they are</p>

            <label className="field">
              <span>Name *</span>
              <input value={form.name} onChange={change("name")} required autoFocus maxLength={150} />
            </label>

            <label className="field">
              <span>Employee code</span>
              <input value={form.employeeCode} onChange={change("employeeCode")} maxLength={30} />
              <small className="muted">With a linked login, they can sign in with it</small>
            </label>

            <label className="field">
              <span>Mobile</span>
              <input value={form.mobile} onChange={change("mobile")} maxLength={20} />
            </label>

            <label className="field">
              <span>Email</span>
              <input type="email" value={form.email} onChange={change("email")} />
            </label>

            <p className="section-heading field-wide">Their job</p>

            <label className="field">
              <span>Department</span>
              <select value={form.department} onChange={change("department")}>
                {Object.entries(DEPARTMENTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Designation</span>
              <input
                value={form.designation}
                onChange={change("designation")}
                placeholder="Head chef"
              />
            </label>

            <label className="field">
              <span>Employment type</span>
              <select value={form.employmentType} onChange={change("employmentType")}>
                <option value="full_time">Full time</option>
                <option value="part_time">Part time</option>
                <option value="contract">Contract</option>
              </select>
            </label>

            <label className="field">
              <span>Gender</span>
              <select value={form.gender} onChange={change("gender")}>
                <option value="">Not given</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </select>
              <small className="muted">Used for professional tax where a state taxes women differently.</small>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            <label className="field">
              <span>Date of joining</span>
              <input type="date" value={form.dateOfJoining} onChange={change("dateOfJoining")} />
            </label>

            <label className="field">
              <span>Date of leaving</span>
              <input type="date" value={form.dateOfLeaving} onChange={change("dateOfLeaving")} />
            </label>

            {outlets.length > 0 && (
              <label className="field">
                <span>Outlet</span>
                <select value={form.outletId} onChange={change("outletId")}>
                  <option value="">All outlets</option>
                  {outlets.map((outlet) => (
                    <option key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {users.length > 0 && (
              <label className="field">
                <span>Linked login</span>
                <select value={form.userId} onChange={change("userId")}>
                  <option value="">No login</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} ({user.email || user.mobile})
                    </option>
                  ))}
                </select>
                <small className="muted">Only if this person signs in to the system</small>
              </label>
            )}

            {canSeePay && <p className="section-heading field-wide">Pay</p>}

            {canSeePay && (
              <label className="field">
                <span>Salary type</span>
                <select value={form.salaryType} onChange={change("salaryType")}>
                  {Object.entries(SALARY_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {canSeePay && (
              <label className="field">
                <span>Salary ({currency})</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.salaryAmount}
                  onChange={change("salaryAmount")}
                />
              </label>
            )}

            {planned.length > 0 && !salaryChanged && (
              <p className="field-wide acc-salary-planned small">
                <strong>
                  {planned.length === 1 ? "A raise is" : `${planned.length} raises are`} already planned.
                </strong>{" "}
                Today {moneyExact(editing.salaryAmount, currency)} {SALARY_TYPES[editing.salaryType]?.toLowerCase()}
                {planned.map((line, index) => (
                  <span key={line.from}>
                    {index === 0 ? ", " : ", then "}
                    {moneyExact(line.salaryAmount, currency)}
                    {line.salaryType !== (index === 0 ? editing : planned[index - 1]).salaryType &&
                      ` ${SALARY_TYPES[line.salaryType]?.toLowerCase()}`}{" "}
                    from {dayText(line.from)}
                  </span>
                ))}
                . The salary box shows the last one entered: leave it as it is and every planned raise stays.
              </p>
            )}

            {salaryChanged && (
              <div className="field field-wide acc-salary-from">
                <label className="field">
                  <span>New salary applies from</span>
                  <input
                    type="date"
                    value={salaryFromShown}
                    min={earliestNewSalary || undefined}
                    onChange={change("salaryEffectiveFrom")}
                  />
                </label>
                {firstSalaryFrom ? (
                  <p className="muted small">
                    This is {editing.name}'s first salary, so it applies from {dayText(firstSalaryFrom)}, when they
                    started: the days they have already worked are paid at it. Pick a later date only if their pay
                    really starts later.
                  </p>
                ) : (
                  <p className="muted small">
                    Days before this date keep the salary they had then (today{" "}
                    {moneyExact(editing.salaryAmount, currency)} {SALARY_TYPES[editing.salaryType]?.toLowerCase()}), so
                    months already worked or paid are not worked out again.
                    {earliestNewSalary &&
                      ` Pay is marked paid up to ${dayText(salaryHistory.paidThrough)}, so the earliest start is ${dayText(earliestNewSalary)}; for a raise that goes back further, add the difference as a bonus on Payroll.`}
                  </p>
                )}
                {replaced.length > 0 && (
                  <p className="acc-salary-replaces small" role="note">
                    Saving this replaces what is planned from {dayText(salaryFromShown)} on:{" "}
                    {replaced
                      .map(
                        (line) =>
                          `${moneyExact(line.salaryAmount, currency)} ${SALARY_TYPES[line.salaryType]?.toLowerCase()} from ${dayText(line.from)}`
                      )
                      .join(" and ")}

                    . To leave the plan as it is, put the salary back to{" "}
                    {moneyExact(savedSalary(editing).salaryAmount, currency)}{" "}
                    {SALARY_TYPES[savedSalary(editing).salaryType]?.toLowerCase()}.
                  </p>
                )}
              </div>
            )}

            {canSeePay && editing.id && salaryHistory && salaryHistory.items.length > 0 && (
              <div className="field field-wide">
                <span className="acc-field-label">Salary history</span>
                <ul className="acc-salary-history">
                  {[...salaryHistory.items].reverse().map((line) => (
                    <li key={line.id}>
                      <strong>
                        {moneyExact(line.salaryAmount, currency)} {SALARY_TYPES[line.salaryType]?.toLowerCase()}
                      </strong>
                      <span className="muted small">
                        from {dayText(line.from)}
                        {line.setBy ? ` · set by ${line.setBy}` : ""}
                      </span>
                      {line.from > today() ? (
                        <span className="badge badge-warning status-badge">
                          <span className="badge-dot" aria-hidden="true" />
                          Not started yet
                        </span>
                      ) : (
                        line.id === currentSalaryLine && (
                          <span className="badge badge-active status-badge">
                            <span className="badge-dot" aria-hidden="true" />
                            Current
                          </span>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {canSeePay && (
              <>
                <p className="section-heading field-wide">PF, ESI and professional tax</p>
                <div className="field field-wide asw-statutory-checks">
                  <label className="checkbox">
                    <input type="checkbox" checked={form.pfApplicable} onChange={(event) => setForm({ ...form, pfApplicable: event.target.checked })} />
                    <span>PF (provident fund)</span>
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={form.esiApplicable} onChange={(event) => setForm({ ...form, esiApplicable: event.target.checked })} />
                    <span>ESI</span>
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={form.ptApplicable} onChange={(event) => setForm({ ...form, ptApplicable: event.target.checked })} />
                    <span>Professional tax</span>
                  </label>
                </div>
                <label className="field">
                  <span>UAN</span>
                  <input value={form.uan} onChange={change("uan")} inputMode="numeric" maxLength={14} placeholder="12 digits" />
                </label>
                <label className="field">
                  <span>ESI number</span>
                  <input value={form.esiNumber} onChange={change("esiNumber")} inputMode="numeric" maxLength={20} placeholder="10 digits" />
                </label>
                <label className="field">
                  <span>Basic wages share (%)</span>
                  <input type="number" min="50" max="100" step="1" value={form.basicPercent} onChange={change("basicPercent")} />
                  <small className="muted">PF is worked out on this part of pay (at least half)</small>
                </label>
                <p className="muted small field-wide">
                  These count only when PF, ESI or professional tax is switched on under Payroll. With them off, nothing
                  changes in anyone's pay.
                </p>

                <p className="section-heading field-wide">Salary bank account</p>
                <FormField label="Account number" optional hint="Digits only, as on the passbook">
                  <input
                    value={form.bankAccountNumber}
                    onChange={change("bankAccountNumber")}
                    inputMode="numeric"
                    maxLength={24}
                    pattern="[0-9 ]{6,24}"
                    title="6 to 20 digits"
                  />
                </FormField>
                <FormField label="IFSC" optional hint="11 characters, like HDFC0001234">
                  <input
                    value={form.bankIfsc}
                    onChange={(event) => setForm({ ...form, bankIfsc: event.target.value.toUpperCase() })}
                    maxLength={11}
                    pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}"
                    title="4 letters, a zero, then 6 letters or digits (like HDFC0001234)"
                    autoCapitalize="characters"
                  />
                </FormField>
                <FormField label="Name on the account" optional hint="Only when it is not the name above" wide>
                  <input value={form.bankAccountName} onChange={change("bankAccountName")} maxLength={150} />
                </FormField>
                <p className="muted small field-wide">
                  Used for Payroll's "Export for bank" sheet. Seen only by people who may see salaries.
                </p>
              </>
            )}

            <p className="section-heading field-wide">Other details</p>

            <label className="field">
              <span>Emergency contact</span>
              <input
                value={form.emergencyContact}
                onChange={change("emergencyContact")}
                maxLength={20}
              />
            </label>

            <label className="field">
              <span>Notes</span>
              <input value={form.notes} onChange={change("notes")} />
            </label>

            <label className="field field-wide">
              <span>Address</span>
              <textarea rows={2} value={form.address} onChange={change("address")} />
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

      {deleting && (
        <ConfirmDialog
          title="Remove employee"
          message={`Remove "${deleting.name}"? Only someone added by mistake can be removed. Anyone with attendance, time-clock punches, deliveries or pay records is set to inactive instead, so their history stays.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}

      {pinEditing && (
        <ClockPinModal
          row={pinEditing}
          onClose={() => setPinEditing(null)}
          onSaved={(message) => {
            setPinEditing(null);
            setError("");
            setSuccess(message);
            refreshPins();
          }}
        />
      )}

      {pinRemoving && (
        <ConfirmDialog
          title="Remove clock PIN"
          message={`Remove ${pinRemoving.name}'s clock PIN? They cannot clock in at the tablet until a new PIN is set. Their past punches stay as they are.`}
          confirmLabel="Remove PIN"
          onConfirm={confirmRemovePin}
          onCancel={() => setPinRemoving(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
