import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import Modal from "../../../components/Modal";
import ConfirmDialog from "../../../components/ConfirmDialog";
import ActionMenu from "../../../components/ActionMenu";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../components/StatusBadge";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../components/StatTile";
import SearchPicker from "../../../components/SearchPicker";
import SectionCard from "../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../components/Feedback";
import {
  clearUserPin,
  createUser,
  getAccessSettings,
  getUserSignIns,
  listUsers,
  resetUserPassword,
  resetUserTwoFactor,
  saveAccessSettings,
  saveTwoFactorRoles,
  setUserPin,
  signOutUser,
  unlockUser,
  updateUser,
} from "../services/user.service";
import { listRoles } from "../services/role.service";
import { listOutlets } from "../../../services/outlet.service";
import { getErrorMessage } from "../../../services/api";
import { count, dateTime } from "@bmp/shared/format";
import useAuth from "../../../hooks/useAuth";
import ActivityLog from "../../restaurant/reports/pages/ActivityLog";
import SignInHistoryGrid from "./SignInHistoryGrid";
import "../../../styles/access.css";
import "../../../styles/access-sweep.css";
import "../styles/access-pro.css";

const EMPTY = {
  name: "",
  email: "",
  mobile: "",
  password: "",
  outletId: "",
  status: "active",
  roleIds: [],
};

const LOCK_CHOICES = [
  { value: 0, label: "Never" },
  { value: 2, label: "2 minutes" },
  { value: 5, label: "5 minutes" },
  { value: 10, label: "10 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
];

const timeOf = (value) =>
  new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const lastSeen = (value) => {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();

  return sameDay
    ? `Today ${timeOf(value)}`
    : dateTime(value);
};

// People who sign in, what they can do, and the controls around it: personal
// PINs, sign-in lockouts, "sign out everywhere", sign-in history, how a shared
// till locks itself — and, for anyone allowed to read it, the activity log.
export default function UsersPage() {
  const { user: currentUser, hasPermission } = useAuth();
  const canManage = hasPermission("users.manage");
  const canAudit = hasPermission("audit.view");
  const [params, setParams] = useSearchParams();
  const tab = ["people", "till", "activity"].includes(params.get("tab")) ? params.get("tab") : "people";

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [outlets, setOutlets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [roleQuery, setRoleQuery] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [resetting, setResetting] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [pinFor, setPinFor] = useState(null);
  const [pinForm, setPinForm] = useState({ pin: "", confirmPin: "" });
  const [history, setHistory] = useState(null);
  const [confirm, setConfirm] = useState(null);

  // A restaurant's list collects everyone who ever worked there, so it opens
  // on the people who can sign in today.
  const [show, setShow] = useState("active");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");

  const [settings, setSettings] = useState(null);
  const [lockMinutes, setLockMinutes] = useState(0);
  const [settingsMessage, setSettingsMessage] = useState("");
  // The roles whose holders must use two-step sign-in, as ticked on screen.
  const [twoStepRoles, setTwoStepRoles] = useState([]);
  const [twoStepMessage, setTwoStepMessage] = useState("");

  const mine = useMemo(() => new Set(currentUser.permissions), [currentUser.permissions]);

  // `loading` starts true, so nothing is set synchronously while the effect runs.
  const load = useCallback(() => {
    // Outlets are optional: a user without outlets.view still manages users.
    if (hasPermission("outlets.view")) {
      listOutlets()
        .then(setOutlets)
        .catch(() => setOutlets([]));
    }

    // The full roles list needs "view roles". Someone who may only see people
    // (a supervisor) still gets the role filter, built from the roles people
    // actually hold.
    const canSeeRoles = hasPermission("roles.view");

    return Promise.all([listUsers(), canSeeRoles ? listRoles() : Promise.resolve(null)])
      .then(([userRows, roleRows]) => {
        setUsers(userRows);

        const held = new Map();
        userRows.forEach((row) => (row.roleList || []).forEach((role) => held.set(Number(role.id), { ...role, status: "active" })));

        // SUPER_ADMIN belongs to the platform, so it is never offered here.
        setRoles(
          (roleRows || [...held.values()].sort((a, b) => a.name.localeCompare(b.name))).filter(
            (role) => role.code !== "SUPER_ADMIN" && role.status === "active"
          )
        );
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [hasPermission]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getAccessSettings()
      .then((data) => {
        setSettings(data);
        setLockMinutes(data.idleLockMinutes);
        setTwoStepRoles((data.twoFactorRoles || []).map((role) => Number(role.id)));
      })
      .catch(() => setSettings(null));
  }, []);

  const showTab = (next) => {
    setParams(next === "people" ? {} : { tab: next }, { replace: true });
  };

  const done = (message) => {
    setSuccess(message);
    setError("");
  };

  // --- Add / edit ---

  const openNew = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const openEdit = (row) => {
    setForm({
      name: row.name,
      email: row.email || "",
      mobile: row.mobile || "",
      password: "",
      outletId: row.outletId ? String(row.outletId) : "",
      status: row.status,
      roleIds: row.roleIds.map(Number),
    });
    setFormError("");
    setEditing(row);
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const toggleRole = (roleId) =>
    setForm({
      ...form,
      roleIds: form.roleIds.includes(roleId)
        ? form.roleIds.filter((id) => id !== roleId)
        : [...form.roleIds, roleId],
    });

  // A role holding permissions you lack cannot be handed out by you (the
  // server refuses too); it is shown, greyed, so the reason is visible.
  const beyondMe = (role) => role.permissions.some((code) => !mine.has(code));

  const save = async (event) => {
    event.preventDefault();
    setFormError("");

    if (!form.email.trim() && !form.mobile.trim()) {
      setFormError("Give an email or a mobile number — staff sign in with either");
      return;
    }

    setSaving(true);

    const payload = {
      name: form.name,
      email: form.email.trim() || null,
      mobile: form.mobile.trim() || null,
      outletId: form.outletId ? Number(form.outletId) : null,
      status: form.status,
      roleIds: form.roleIds,
    };

    try {
      if (editing.id) {
        await updateUser(editing.id, payload);
        done(`${form.name} updated`);
      } else {
        await createUser({ ...payload, password: form.password });
        done(`${form.name} added. They can sign in now${form.mobile ? " with their mobile number" : ""}.`);
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // --- Row actions ---

  const submitReset = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      const result = await resetUserPassword(resetting.id, newPassword);
      setResetting(null);
      setNewPassword("");
      done(result.message);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const submitPin = async (event) => {
    event.preventDefault();
    setFormError("");

    if (!/^\d{4,6}$/.test(pinForm.pin)) {
      setFormError("The PIN must be 4 to 6 digits");
      return;
    }

    if (pinForm.pin !== pinForm.confirmPin) {
      setFormError("The two PINs do not match");
      return;
    }

    setSaving(true);

    try {
      const result = await setUserPin(pinFor.id, pinForm.pin, pinForm.confirmPin);
      setPinFor(null);
      done(`${result.message}. Tell them the PIN; they can change it under My profile.`);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openHistory = (row) => {
    setHistory({ user: row, items: null });
    getUserSignIns(row.id)
      .then((data) => setHistory({ user: row, items: data.items }))
      .catch((err) => setHistory({ user: row, items: [], error: getErrorMessage(err) }));
  };

  const runConfirmed = async () => {
    setSaving(true);

    try {
      const result = await confirm.run();
      done(result.message);
      setConfirm(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const quick = async (action) => {
    try {
      const result = await action();
      done(result.message);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    setSettingsMessage("");

    try {
      const saved = await saveAccessSettings({ idleLockMinutes: Number(lockMinutes) });
      setSettings(saved);
      setSettingsMessage(
        saved.idleLockMinutes
          ? `Saved. Tills lock after ${saved.idleLockMinutes} minute${saved.idleLockMinutes === 1 ? "" : "s"} without a touch (from the next sign-in or page load).`
          : "Saved. Tills never lock on their own."
      );
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const saveTwoStepRoles = async (event) => {
    event.preventDefault();
    setTwoStepMessage("");

    try {
      const result = await saveTwoFactorRoles(twoStepRoles);
      setSettings({ ...settings, twoFactorRoles: result.data });
      setTwoStepMessage(result.message);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const savedTwoStep = (settings?.twoFactorRoles || []).map((role) => Number(role.id)).sort().join(",");
  const twoStepChanged = [...twoStepRoles].sort().join(",") !== savedTwoStep;

  const totals = useMemo(() => {
    const todayText = new Date().toDateString();
    const active = users.filter((row) => row.status === "active");

    return {
      active: active.length,
      twoStep: active.filter((row) => row.twoFactorEnabled).length,
      twoStepMissing: active.filter((row) => row.twoFactorRequired && !row.twoFactorEnabled).length,
      withPin: active.filter((row) => row.hasPin).length,
      locked: users.filter((row) => row.loginLockedUntil || row.pinLockedUntil).length,
      switchedOff: users.length - active.length,
      // Read from the last sign-in the list already carries: who has been
      // in today, at a glance, without opening anyone's history.
      today: active.filter((row) => row.lastLoginAt && new Date(row.lastLoginAt).toDateString() === todayText).length,
    };
  }, [users]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    return users.filter(
      (row) =>
        (show === "all" || (show === "active" ? row.status === "active" : row.status !== "active")) &&
        (!roleFilter || row.roleIds.map(Number).includes(Number(roleFilter))) &&
        (!term ||
          [row.name, row.email, row.mobile, row.employeeCode]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term)))
    );
  }, [users, show, search, roleFilter]);

  const actionsFor = (row) => {
    const self = row.id === currentUser.id;
    const locked = row.loginLockedUntil || row.pinLockedUntil;

    // Edit is the everyday one and sits on the row itself; these are the rest.
    return [
      {
        label: row.hasPin ? "Change PIN" : "Set PIN",
        icon: "key",
        onClick: () => {
          setPinFor(row);
          setPinForm({ pin: "", confirmPin: "" });
          setFormError("");
        },
      },
      {
        label: "Reset password",
        icon: "lock",
        onClick: () => {
          setResetting(row);
          setNewPassword("");
          setFormError("");
        },
      },
      { label: "Sign-in history", icon: "history", onClick: () => openHistory(row) },
      ...(locked ? [{ label: "Unlock sign-in", icon: "unlock", onClick: () => quick(() => unlockUser(row.id)) }] : []),
      // A lost phone with no recovery codes: an admin switches it off.
      ...(row.twoFactorEnabled && !self
        ? [
            {
              label: "Reset two-step sign-in",
              icon: "shield",
              onClick: () =>
                setConfirm({
                  title: "Reset two-step sign-in",
                  message: `Switch off ${row.name}'s two-step sign-in? Use this when their phone is lost and they have no recovery codes. They are signed out everywhere${
                    row.twoFactorRequired ? ", and set it up again at their next sign-in" : ""
                  }.`,
                  label: "Reset two-step",
                  run: () => resetUserTwoFactor(row.id),
                }),
            },
          ]
        : []),
      { separator: true },
      ...(row.hasPin
        ? [
            {
              label: "Remove PIN",
              icon: "x-circle",
              onClick: () =>
                setConfirm({
                  title: "Remove PIN",
                  message: `Remove ${row.name}'s PIN? They will not be able to unlock a till or approve with it until a new one is set.`,
                  label: "Remove PIN",
                  run: () => clearUserPin(row.id),
                }),
            },
          ]
        : []),
      ...(self
        ? []
        : [
            {
              label: "Sign out everywhere",
              icon: "logout",
              danger: true,
              onClick: () =>
                setConfirm({
                  title: "Sign out everywhere",
                  message: `Sign ${row.name} out on every phone, till and browser now? They can sign in again with their password or PIN.`,
                  label: "Sign out",
                  run: () => signOutUser(row.id),
                }),
            },
          ]),
    ];
  };


  const initials = (name) =>
    String(name || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="user-plus" size={16} /> Add user
    </button>
  );

  const filtered = Boolean(search.trim() || roleFilter);

  const pinBadge = (row) =>
    row.pinLockedUntil ? (
      <span className="badge badge-danger status-badge">
        <span className="badge-dot" aria-hidden="true" />
        Locked till {timeOf(row.pinLockedUntil)}
      </span>
    ) : row.hasPin ? (
      <span className="badge badge-active status-badge">
        <span className="badge-dot" aria-hidden="true" />
        PIN set
      </span>
    ) : (
      <span className="badge badge-neutral status-badge">
        <span className="badge-dot" aria-hidden="true" />
        No PIN
      </span>
    );

  const TABS = [
    { key: "people", label: "People", icon: "users", count: totals.active },
    { key: "till", label: "Till lock & sign-in", short: "Till lock", icon: "lock" },
    ...(canAudit ? [{ key: "activity", label: "Activity log", short: "Activity", icon: "history" }] : []),
  ];

  // The roles the user form lists: every built-in role, the ones ticked, and
  // up to 30 of the restaurant's own roles matching what was typed.
  const roleWords = roleQuery.trim().toLowerCase();
  const ownMatching = roles.filter(
    (role) => !role.isSystem && (!roleWords || role.name.toLowerCase().includes(roleWords))
  );
  const ownShown = ownMatching.slice(0, roleWords ? 30 : roles.filter((role) => !role.isSystem).length <= 12 ? 12 : 0);
  const shownRoles = roles.filter(
    (role) => role.isSystem || ownShown.includes(role) || (form && form.roleIds && form.roleIds.includes(role.id))
  );
  const hiddenRoles = roles.length - shownRoles.length;

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="shield"
        title="Users"
        description="Who can sign in, what each person may do, and how the shared tills are kept safe."
        action={tab === "people" ? addButton : null}
      />

      <div className="acc-tabs" role="tablist" aria-label="Users sections" data-motion-tabs>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`acc-tab ${tab === item.key ? "is-active" : ""}`}
            onClick={() => showTab(item.key)}
          >
            <Icon name={item.icon} size={16} />
            {item.short ? (
              <>
                <span className="acc-tab-long">{item.label}</span>
                <span className="acc-tab-short">{item.short}</span>
              </>
            ) : (
              item.label
            )}
            {item.count !== undefined && !loading && <span className="acc-tab-count">{count(item.count)}</span>}
          </button>
        ))}
      </div>

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {tab === "activity" && canAudit && <ActivityLog />}

      {tab === "till" && (
        <div className="acc-two-col">
          <SectionCard
            as="form"
            onSubmit={saveSettings}
            icon="lock"
            title="Lock a shared till when nobody is using it"
            description="A counter tablet left signed in is anyone's. After this long without a touch the screen locks."
          >
            <div className="stack">
              <p className="muted small acc-till-note">
                The person using it unlocks with their PIN and carries on where they were, or someone else taps their
                name and takes over with their own PIN — so the activity log always says who did what.
              </p>

              <label className="field acc-lock-field">
                <span>Lock after</span>
                <select
                  value={lockMinutes}
                  onChange={(event) => setLockMinutes(Number(event.target.value))}
                  disabled={!canManage}
                >
                  {LOCK_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                {!canManage && <small className="muted">Only someone who manages users can change this</small>}
              </label>

              {settingsMessage && (
                <div className="alert alert-success" role="status">
                  {settingsMessage}
                </div>
              )}

              {canManage && (
                <div className="form-actions">
                  <button
                    type="submit"
                    className="button"
                    disabled={!settings || Number(lockMinutes) === Number(settings.idleLockMinutes)}
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard
            icon="info"
            tone="info"
            title="How staff sign in"
            description="The rules every login follows. Nothing here needs setting up."
          >
            <ul className="acc-facts">
              <li>
                <span className="acc-fact-icon tone-info" aria-hidden="true">
                  <Icon name="login" size={16} />
                </span>
                <span>
                  <strong>Email, mobile number or staff code.</strong> A staff code (the employee code on the Employees
                  page, linked to their login) needs the restaurant code too:{" "}
                  <span className="mono acc-code">{currentUser.restaurantCode || "—"}</span>
                </span>
              </li>
              <li>
                <span className="acc-fact-icon tone-danger" aria-hidden="true">
                  <Icon name="lock" size={16} />
                </span>
                <span>
                  <strong>Five wrong passwords in 15 minutes</strong> lock that account for 15 minutes. Wrong PINs lock
                  the PIN the same way. Unlock early from the person's ⋯ menu on the People tab.
                </span>
              </li>
              <li>
                <span className="acc-fact-icon tone-warning" aria-hidden="true">
                  <Icon name="refresh" size={16} />
                </span>
                <span>
                  <strong>Changing or resetting a password</strong> signs that person out everywhere else at once.
                </span>
              </li>
              <li>
                <span className="acc-fact-icon tone-primary" aria-hidden="true">
                  <Icon name="key" size={16} />
                </span>
                <span>
                  <strong>Personal PIN</strong>: unlocks a till, takes over a till, and — for managers — approves a void,
                  refund or day close at someone else's till.
                </span>
              </li>
              <li>
                <span className="acc-fact-icon tone-success" aria-hidden="true">
                  <Icon name="shield" size={16} />
                </span>
                <span>
                  <strong>Two-step sign-in</strong>: after the password, a code from an app on their phone. Anyone can
                  turn it on under My profile; the roles ticked below must.
                </span>
              </li>
            </ul>

            {!loading && (
              <div className="acc-mini-tiles">
                <StatTile size="sm" icon="users" tone="primary" label="Active logins" value={count(totals.active)} />
                <StatTile
                  size="sm"
                  icon="key"
                  tone={totals.withPin < totals.active ? "warning" : "success"}
                  label="With a PIN"
                  value={count(totals.withPin)}
                />
                <StatTile
                  size="sm"
                  icon="lock"
                  tone={totals.locked ? "danger" : "neutral"}
                  label="Locked out now"
                  value={count(totals.locked)}
                />
              </div>
            )}
          </SectionCard>

          <SectionCard
            as="form"
            onSubmit={saveTwoStepRoles}
            icon="shield"
            tone="success"
            title="Who must use two-step sign-in"
            description="Tick the roles that can see the money or change who does what. Someone in a ticked role without two-step is taken to set it up straight after their password."
            className="asw-twostep-roles"
          >
            <div className="stack">
              <div className="asw-role-checks">
                {roles.map((role) => {
                  const checked = twoStepRoles.includes(Number(role.id));

                  return (
                    <label key={role.id} className={`checkbox acc-role-option ${checked ? "is-checked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManage}
                        onChange={() =>
                          setTwoStepRoles(
                            checked ? twoStepRoles.filter((id) => id !== Number(role.id)) : [...twoStepRoles, Number(role.id)]
                          )
                        }
                      />
                      <span className="acc-role-text">
                        <strong>{role.name}</strong>
                        {role.code === "RESTAURANT_ADMIN" && <small className="muted">Recommended: it can change everything</small>}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="acc-mini-tiles">
                <StatTile size="sm" icon="shield" tone="success" label="Two-step on" value={count(totals.twoStep)} of={`/${count(totals.active)}`} />
                <StatTile
                  size="sm"
                  icon="alert"
                  tone={totals.twoStepMissing ? "warning" : "neutral"}
                  label="Still to set up"
                  value={count(totals.twoStepMissing)}
                  note="in ticked roles"
                />
              </div>
              {twoStepMessage && (
                <div className="alert alert-success" role="status">
                  {twoStepMessage}
                </div>
              )}
              {canManage && (
                <div className="form-actions">
                  <button type="submit" className="button" disabled={!settings || !twoStepChanged}>
                    Save
                  </button>
                </div>
              )}
            </div>
          </SectionCard>
        </div>
      )}

      {tab === "people" && (
        <>
          {!loading && users.length > 0 && (
            <div className="stat-grid">
              <StatTile
                icon="users"
                tone="primary"
                label="Active logins"
                value={count(totals.active)}
                note={totals.switchedOff ? `${count(totals.switchedOff)} switched off` : "nobody switched off"}
              />
              <StatTile
                icon="key"
                tone={totals.withPin < totals.active ? "warning" : "success"}
                label="Personal PIN"
                value={count(totals.withPin)}
                of={`/${count(totals.active)}`}
                note={
                  totals.withPin < totals.active
                    ? `${count(totals.active - totals.withPin)} cannot unlock a till yet`
                    : "everyone can unlock a till"
                }
              />
              <StatTile
                icon="lock"
                tone={totals.locked ? "danger" : "neutral"}
                label="Locked out now"
                value={count(totals.locked)}
                note={totals.locked ? "unlock from their ⋯ menu" : "nobody is locked out"}
              />
              <StatTile
                icon="login"
                tone="info"
                label="Signed in today"
                value={count(totals.today)}
                note="of the active logins"
              />
            </div>
          )}

          <SectionCard
            icon="list"
            title="Logins"
            description={
              canManage
                ? "Edit changes someone's details and roles. Their PIN, password, sign-in history and lockouts are in the ⋯ menu."
                : "Everyone who can sign in, with their roles and when they last did."
            }
            actions={
              !loading &&
              users.length > 0 && (
                <span className="acc-count">
                  {count(visible.length)} {visible.length === 1 ? "person" : "people"}
                </span>
              )
            }
            flush
          >
            <DataGrid
              id="users"
              caption="Logins"
              columns={[
                {
                  key: "name",
                  header: "Name",
                  width: 200,
                  value: (row) => row.name,
                  mobile: "title",
                  pin: true,
                  render: (row) => (
                    <div className="acc-who">
                      <span className="acc-avatar" aria-hidden="true">
                        {initials(row.name)}
                      </span>
                      <span className="acc-who-text">
                        <strong>
                          {row.name}
                          {row.id === currentUser.id && <span className="tag acc-you">You</span>}
                        </strong>
                        {row.employeeCode && <span className="muted small mono">Staff code {row.employeeCode}</span>}
                      </span>
                    </div>
                  ),
                },
                {
                  key: "signsInWith",
                  header: "Signs in with",
                  width: 210,
                  className: "asw-log-cell",
                  value: (row) => [row.email, row.mobile].filter(Boolean).join(" · "),
                  mobile: "show",
                  render: (row) => (
                    <span className="small asw-email-cell">
                      {row.email && <span className="acc-block">{row.email}</span>}
                      {row.mobile && <span className={`acc-block ${row.email ? "muted" : ""}`}>{row.mobile}</span>}
                    </span>
                  ),
                },
                {
                  // The outlet sits under the roles: a login is "Cashier at
                  // Banjara Hills", and the row stays inside the screen.
                  key: "roles",
                  header: "Roles · outlet",
                  width: 170,
                  className: "asw-log-cell",
                  value: (row) => (row.roleNames || row.roles).join(", "),
                  csv: (row) => `${(row.roleNames || row.roles).join(", ")} (${row.outletName || "All outlets"})`,
                  mobile: "show",
                  render: (row) => (
                    <span className="small">
                      {(row.roleNames || row.roles).join(", ") || "—"}
                      <span className="muted acc-block">{row.outletName || "All outlets"}</span>
                    </span>
                  ),
                },
                {
                  key: "pin",
                  header: "PIN",
                  width: 98,
                  value: (row) => (row.pinLockedUntil ? "Locked" : row.hasPin ? "Set" : "Not set"),
                  render: (row) => <span className="nowrap">{pinBadge(row)}</span>,
                },
                {
                  key: "status",
                  header: "Status",
                  type: "status",
                  width: 132,
                  className: "asw-log-cell",
                  value: (row) => row.status,
                  mobile: "subtitle",
                  csv: (row) => `${row.status}${row.twoFactorEnabled ? ", two-step on" : ""}${row.loginLockedUntil ? ", locked" : ""}`,
                  render: (row) => (
                    <>
                      <StatusBadge status={row.status} />
                      {row.twoFactorEnabled ? (
                        <span className="badge badge-active asw-twostep-badge">
                          <Icon name="shield" size={12} /> Two-step on
                        </span>
                      ) : row.twoFactorRequired && row.status === "active" ? (
                        <span
                          className="badge badge-warning asw-twostep-badge"
                          title="Their role needs two-step sign-in; they set it up at their next sign-in"
                        >
                          <Icon name="shield" size={12} /> Two-step to set up
                        </span>
                      ) : null}
                      {row.loginLockedUntil && (
                        <div className="small text-danger acc-locked-line">Sign-in locked till {timeOf(row.loginLockedUntil)}</div>
                      )}
                    </>
                  ),
                },
                {
                  key: "lastLogin",
                  header: "Last sign-in",
                  width: 146,
                  type: "datetime",
                  value: (row) => row.lastLoginAt,
                  mobile: "show",
                  render: (row) => <span className="small nowrap">{lastSeen(row.lastLoginAt)}</span>,
                },
                canManage && {
                  key: "actions",
                  header: "",
                  label: "Actions",
                  type: "actions",
                  render: (row) => (
                    <div className="row-actions">
                      <button type="button" className="chip-button" onClick={() => openEdit(row)}>
                        <Icon name="edit" size={14} /> Edit
                      </button>
                      <ActionMenu label={`Actions for ${row.name}`} items={actionsFor(row)} />
                    </div>
                  ),
                },
              ]}
              rows={visible}
              rowKey={(row) => row.id}
              loading={loading}
              empty={users.length === 0 ? "No logins yet" : filtered ? "Nobody matches" : show === "inactive" ? "No switched-off logins" : "Nobody here"}
              emptyIcon={filtered ? "search" : "users"}
              emptyHint={
                users.length === 0
                  ? "Add a login for everyone who uses the till, the kitchen screen or this back office. Staff who only clock in need no login."
                  : filtered
                    ? "Check the spelling, or clear the search and the role."
                    : show === "inactive"
                      ? "Someone who leaves is switched off rather than deleted, so their history stays. They will show here."
                      : "Show all logins to see everyone."
              }
              emptyAction={
                users.length === 0 ? (
                  addButton
                ) : filtered ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setSearch("");
                      setRoleFilter("");
                    }}
                  >
                    Clear filters
                  </button>
                ) : null
              }
              rowClassName={(row) => (row.status === "active" ? (row.loginLockedUntil ? "dg-tone-danger" : "") : "dg-tone-muted")}
              // The search also finds mobiles and staff codes, so it stays the
              // page's own (the list is filtered before it reaches the grid).
              search={{ value: search, placeholder: "Name, mobile or code", onChange: setSearch }}
              toolbar={
                <>
                  <div className="field acc-role-filter">
                    <SearchPicker
                      label="Role"
                      value={roles.find((role) => String(role.id) === String(roleFilter)) || null}
                      onChange={(role) => setRoleFilter(role ? String(role.id) : "")}
                      options={roles}
                      getKey={(role) => role.id}
                      getLabel={(role) => role.name}
                      getDescription={(role) => (role.isSystem ? "Built-in" : "")}
                      placeholder="All roles"
                      emptyText="No role has that name"
                    />
                  </div>

                  <div className="field acc-show-field">
                    <span>Show</span>
                    <div className="segmented" role="radiogroup" aria-label="Which logins">
                      {[
                        { key: "active", label: `Active (${count(totals.active)})` },
                        { key: "inactive", label: "Switched off" },
                        { key: "all", label: "All" },
                      ].map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          role="radio"
                          aria-checked={show === option.key}
                          className={`segment ${show === option.key ? "is-active" : ""}`}
                          onClick={() => setShow(option.key)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              }
              exportName="logins"
            />
          </SectionCard>
        </>
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : "Add user"}
          description={
            editing.id
              ? "Their sign-in details, outlet and roles. The password and PIN are changed from the ⋯ menu."
              : "A login for someone who uses the till, the kitchen screen or this back office."
          }
          icon={editing.id ? "user" : "user-plus"}
          onClose={() => setEditing(null)}
          width={640}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">How they sign in</p>

            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={change("name")} required autoFocus maxLength={150} />
            </label>

            <label className="field">
              <span>Mobile</span>
              <input value={form.mobile} onChange={change("mobile")} inputMode="tel" maxLength={20} />
              <small className="muted">They can sign in with it (or with an email)</small>
            </label>

            <label className="field">
              <span>Email (optional)</span>
              <input type="email" value={form.email} onChange={change("email")} />
              <small className="muted">Needed only if they have one</small>
            </label>

            {!editing.id && (
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={change("password")}
                  minLength={8}
                  required
                  autoComplete="new-password"
                />
                <small className="muted">At least 8 characters</small>
              </label>
            )}

            <p className="section-heading field-wide">Where they work</p>

            <div className="field">
              <SearchPicker
                label="Outlet"
                value={outlets.find((outlet) => String(outlet.id) === String(form.outletId)) || null}
                onChange={(outlet) => setForm((all) => ({ ...all, outletId: outlet ? String(outlet.id) : "" }))}
                options={outlets}
                getKey={(outlet) => outlet.id}
                getLabel={(outlet) => `${outlet.name}${outlet.status !== "active" ? " (inactive)" : ""}`}
                getKeywords={(outlet) => outlet.code || ""}
                placeholder="All outlets"
                emptyText="No outlet has that name"
                hint="Tie them to one outlet, or leave it open"
              />
            </div>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="locked">Locked</option>
              </select>
              <small className="muted">Inactive or locked cannot sign in</small>
            </label>

            <fieldset className="field field-wide acc-role-fieldset">
              <legend>
                Roles<span className="muted small"> · what they may do; a role you do not fully hold is greyed</span>
              </legend>
              {/* The built-in roles always show, with what each is for; a
                  restaurant's own roles (there can be hundreds) are found by
                  name, and the ones already ticked stay in view. */}
              {roles.some((role) => !role.isSystem) && (
                <input
                  type="search"
                  className="acc-role-search"
                  aria-label="Find a role"
                  placeholder="Find one of your own roles by name"
                  value={roleQuery}
                  onChange={(event) => setRoleQuery(event.target.value)}
                />
              )}
              <div className="acc-role-grid">
                {shownRoles.map((role) => {
                  const blocked = beyondMe(role) && !form.roleIds.includes(role.id);
                  const checked = form.roleIds.includes(role.id);

                  return (
                    <label
                      className={`checkbox acc-role-option ${checked ? "is-checked" : ""} ${blocked ? "acc-blocked" : ""}`}
                      key={role.id}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleRole(role.id)} disabled={blocked} />
                      <span className="acc-role-text">
                        <strong>{role.name}</strong>
                        <small className="muted">
                          {role.isSystem && role.description ? <span className="acc-role-desc">{role.description}</span> : null}
                          {role.permissions.length} permissions{blocked ? " — includes access you do not have" : ""}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {hiddenRoles > 0 && (
                <p className="muted small">
                  {count(hiddenRoles)} more of your own roles — type a name above to find one.
                </p>
              )}
            </fieldset>

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

      {resetting && (
        <Modal
          title={`Reset password — ${resetting.name}`}
          description="They are signed out everywhere at once, and sign in again with the new one."
          icon="lock"
          onClose={() => setResetting(null)}
          width={440}
        >
          <form className="form-grid" onSubmit={submitReset}>
            <ErrorMessage message={formError} />

            <label className="field field-wide">
              <span>New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={8}
                required
                autoFocus
                autoComplete="new-password"
              />
              <small className="muted">
                At least 8 characters. Tell them their new password; it cannot be read later.
              </small>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setResetting(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Set password"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {pinFor && (
        <Modal
          title={`${pinFor.hasPin ? "Change" : "Set"} PIN — ${pinFor.name}`}
          description={`4 to 6 digits. They use it to unlock or take over a shared till${
            pinFor.roles.some((code) => ["MANAGER", "RESTAURANT_ADMIN"].includes(code))
              ? " and to approve voids, refunds and day close"
              : ""
          }.`}
          icon="key"
          onClose={() => setPinFor(null)}
          width={440}
        >
          <form className="form-grid" onSubmit={submitPin}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pinForm.pin}
                onChange={(event) => setPinForm({ ...pinForm, pin: event.target.value.replace(/\D/g, "") })}
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span>Repeat PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pinForm.confirmPin}
                onChange={(event) =>
                  setPinForm({ ...pinForm, confirmPin: event.target.value.replace(/\D/g, "") })
                }
                required
              />
            </label>

            <p className="muted small field-wide">Tell them the PIN; they can change it under My profile.</p>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setPinFor(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save PIN"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {history && (
        <Modal
          title={`Sign-in history — ${history.user.name}`}
          description="Every sign-in and failed try on this login, with the device it came from."
          icon="history"
          onClose={() => setHistory(null)}
          width={900}
        >
          <ErrorMessage message={history.error} />
          {history.items === null ? (
            <Loading />
          ) : (
            <SignInHistoryGrid
              id="user-sign-ins"
              rows={history.items}
              detailed
              empty="No sign-ins recorded yet"
              emptyHint="Their sign-ins, wrong passwords and lockouts will show here from their first try."
            />
          )}
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          onConfirm={runConfirmed}
          onCancel={() => setConfirm(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
