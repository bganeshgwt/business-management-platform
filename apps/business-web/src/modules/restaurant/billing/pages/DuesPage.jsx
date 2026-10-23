import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import AdvancesPanel from "./AdvancesPanel";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  collectOnAccount,
  getAccountBills,
  getDaySummary,
  getDues,
  getStatement,
  saveAccount,
} from "../services/bill.service";
import { searchGuests } from "../../crm/services/crm.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "@bmp/shared/format";
import { downloadCsv } from "../../../../services/csv";
import { printDocument, escapeHtml } from "../../../../services/print";
import { paymentMethodLabel } from "../../../../services/labels";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { MoneyTabs, Status } from "../../business-day/pages/moneyUi";
import "../../../../styles/billing.css";
import "../styles/dues.css";

// Dues & accounts: everything owed to the restaurant on one screen.
//
//   Accounts  regulars and companies who settle later. Each has a credit
//             limit; bills are put on the account at the till (Bills & payments → open
//             a bill → On account), and what the account owes is simply what
//             is still due on those bills — aged 0–30, 31–60, 61–90 and over
//             90 days. Money collected is paid onto the oldest bills first,
//             into today's business day of the till taking it.
//   Unpaid    bills left unpaid that are on nobody's account.
//   Advances  money guests paid ahead (party deposits, bulk orders), held
//             for them and used on the final bill.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dateText = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : "—";
};

const daysSince = (date, asOf) =>
  date && asOf ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000) : null;

const QUICK_METHODS = ["cash", "upi", "card", "online", "other"];

const n = (value) => Number(value || 0);

export default function DuesPage() {
  const { hasPermission, hasFeature } = useAuth();
  const canSetLimits = hasPermission("customers.credit");
  // A new account is opened for a guest from the guest book (Guests); the
  // Advances tab is Advances & deposits. Existing accounts stay collectable.
  const canOpenAccount = canSetLimits && hasFeature("guests");
  const advancesOn = hasFeature("advances");
  const canCollect = hasPermission("payments.manage");

  const [tab, setTab] = useQueryFilter("tab", "accounts");
  const [data, setData] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("owing");
  const [editing, setEditing] = useState(null);
  const [collecting, setCollecting] = useState(null);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(
    () =>
      getDues()
        .then((loaded) => {
          setData(loaded);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol || "₹"))
      .catch(() => undefined);
  }, [load]);

  const m = (value) => money(value, currency);
  const mx = (value) => moneyExact(value, currency);

  const accounts = useMemo(() => {
    const rows = (data && data.accounts) || [];

    if (filter === "owing") {
      return rows.filter((row) => row.outstanding > 0);
    }

    if (filter === "overdue") {
      return rows.filter(
        (row) => row.outstanding > 0 && row.creditDays !== null && daysSince(row.oldestDue, data.asOf) > row.creditDays
      );
    }

    return rows;
  }, [data, filter]);

  const done = (message) => {
    setNotice(message);
    setEditing(null);
    setCollecting(null);
    load();
  };

  const downloadDues = () => {
    if (!data) {
      return;
    }

    downloadCsv(
      [
        ["Dues", `as of ${data.asOf}`],
        [],
        ["Account", "GSTIN", "Credit limit", "Days to pay", "Owes", "Available", "0-30 days", "31-60 days", "61-90 days", "Over 90 days", "Oldest due", "Status"],
        ...data.accounts.map((row) => [
          row.name,
          row.gstin || "",
          row.creditLimit === null ? "" : row.creditLimit.toFixed(2),
          row.creditDays === null ? "" : row.creditDays,
          row.outstanding.toFixed(2),
          row.available.toFixed(2),
          row.ageing.current.toFixed(2),
          row.ageing.days31to60.toFixed(2),
          row.ageing.days61to90.toFixed(2),
          row.ageing.over90.toFixed(2),
          row.oldestDue || "",
          row.hasAccount ? (row.status === "active" ? "Active" : "On hold") : "No account",
        ]),
        [],
        ["Unpaid bills on no account", "", "", "", data.loose.due.toFixed(2)],
        ["Bill", "Business date", "Days", "Guest", "Outlet", "Due"],
        ...data.loose.bills.map((row) => [
          row.billNumber,
          row.businessDate,
          row.ageDays,
          row.guestName || "",
          row.outletName || "",
          row.due.toFixed(2),
        ]),
      ],
      `dues-${data.asOf}.csv`
    );
  };

  const totals = data ? data.totals : null;
  const old = totals ? n(totals.days61to90) + n(totals.over90) : 0;

  // An age bucket: the amount, or a muted dash.
  const bucket = (value, warn = false) =>
    value ? <span className={warn ? "dues-old" : ""}>{m(value)}</span> : <span className="muted">—</span>;

  const accountColumns = [
    {
      key: "account",
      header: "Account",
      value: (row) => row.name,
      mobile: "title",
      pin: true,
      width: 220,
      render: (row) => (
        <span className="dues-name">
          <strong>{row.name}</strong>
          <span className="muted small">
            {row.companyName && row.guestName !== row.companyName ? `${row.guestName} · ` : ""}
            {row.gstin ? <span className="mono">{row.gstin}</span> : row.mobile || ""}
          </span>
        </span>
      ),
    },
    {
      key: "owes",
      header: "Owes",
      type: "money",
      exact: true,
      total: "sum",
      value: (row) => row.outstanding,
      mobile: "show",
      render: (row) => (
        <span className="dues-cell">
          <strong className={row.outstanding > 0 ? "dues-owes" : ""}>{mx(row.outstanding)}</strong>
          {row.openBills > 0 && (
            <span className="muted small dues-sub">
              {row.openBills} bill{row.openBills === 1 ? "" : "s"}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "limit",
      header: "Limit",
      type: "money",
      value: (row) => row.creditLimit,
      mobile: "show",
      render: (row) => {
        if (row.creditLimit === null) {
          return <span className="muted">—</span>;
        }

        const used = row.creditLimit ? Math.min(100, (row.outstanding / row.creditLimit) * 100) : 0;

        return (
          <span className="dues-cell">
            {m(row.creditLimit)}
            <span className="dues-meter" aria-hidden="true">
              <span style={{ width: `${used}%` }} className={used >= 90 ? "is-full" : ""} />
            </span>
            <span className="muted small dues-sub">{m(row.available)} left</span>
          </span>
        );
      },
    },
    { key: "a0", header: "0–30 days", type: "money", total: "sum", value: (row) => row.ageing.current, render: (row) => bucket(row.ageing.current) },
    { key: "a31", header: "31–60", type: "money", total: "sum", value: (row) => row.ageing.days31to60, render: (row) => bucket(row.ageing.days31to60) },
    { key: "a61", header: "61–90", type: "money", total: "sum", value: (row) => row.ageing.days61to90, render: (row) => bucket(row.ageing.days61to90, true) },
    { key: "a90", header: "90+", type: "money", total: "sum", value: (row) => row.ageing.over90, render: (row) => bucket(row.ageing.over90, true), mobile: "show" },
    {
      key: "oldest",
      header: "Oldest",
      type: "date",
      value: (row) => row.oldestDue,
      render: (row) => {
        if (!row.oldestDue) {
          return <span className="muted">—</span>;
        }

        const age = daysSince(row.oldestDue, data.asOf);
        const overdue = row.outstanding > 0 && row.creditDays !== null && age > row.creditDays;

        return (
          <span className="dues-when" title={`Oldest bill still owed: ${dateText(row.oldestDue)}`}>
            <span className={overdue ? "text-danger" : ""}>
              {age} day{age === 1 ? "" : "s"}
            </span>
            <span className="small muted">{row.creditDays !== null ? `${row.creditDays} to pay` : dateText(row.oldestDue)}</span>
          </span>
        );
      },
    },
    {
      key: "advance",
      header: "Advance held",
      type: "money",
      exact: true,
      total: "sum",
      value: (row) => row.advanceHeld || 0,
      defaultHidden: !(totals && n(totals.advanceHeld) > 0),
      render: (row) => (row.advanceHeld ? <span className="dues-advance">{mx(row.advanceHeld)}</span> : <span className="muted">—</span>),
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      mobile: "subtitle",
      value: (row) =>
        !row.hasAccount
          ? "No account"
          : row.status !== "active"
            ? "On hold"
            : row.outstanding > 0 && row.creditDays !== null && daysSince(row.oldestDue, data.asOf) > row.creditDays
              ? "Overdue"
              : "Active",
      filter: "select",
      render: (row) => {
        const overdue = row.outstanding > 0 && row.creditDays !== null && daysSince(row.oldestDue, data.asOf) > row.creditDays;

        return !row.hasAccount ? (
          <Status tone="neutral">No account</Status>
        ) : row.status !== "active" ? (
          <Status tone="danger">On hold</Status>
        ) : overdue ? (
          <Status tone="warning">Overdue</Status>
        ) : (
          <Status tone="active">Active</Status>
        );
      },
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => (
        <span className="dues-actions">
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={() => setViewing(row)}
            aria-label={`${row.name}'s statement`}
            title="Statement"
          >
            <Icon name="file" size={14} />
            <span className="dues-action-word">Statement</span>
          </button>
          {canCollect && row.outstanding > 0 && (
            <button type="button" className="button button-sm" onClick={() => setCollecting(row)}>
              Collect
            </button>
          )}
          {canSetLimits && (
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => setEditing(row)}
              aria-label={`Edit ${row.name}'s account`}
              title="Edit the limit, days to pay or hold"
            >
              <Icon name="edit" size={14} />
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="stack dues-page">
      <PageHeader
        icon="users"
        title="Dues & accounts"
        description="Regulars and companies who settle later, what each owes and for how long, and bills left unpaid. Put a bill on an account from the bill itself (Bills & payments → open a bill → On account)."
        actions={
          <div className="dues-header-actions">
            <button type="button" className="button button-secondary" onClick={downloadDues} disabled={!data}>
              <Icon name="download" size={16} /> Dues (CSV)
            </button>
            {canOpenAccount && (
              <button type="button" className="button" onClick={() => setEditing({ isNew: true })}>
                <Icon name="plus" size={16} /> Open an account
              </button>
            )}
          </div>
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={notice} />

      {loading ? (
        <Loading label="Reading the accounts…" />
      ) : !data ? null : (
        <>
          <div className="stat-grid">
            <StatTile
              icon="users"
              tone="primary"
              label="Owed on accounts"
              value={m(totals.outstanding)}
              note={`${count(totals.owing)} of ${count(totals.accounts)} account${totals.accounts === 1 ? "" : "s"} owing`}
            />
            <StatTile
              icon="clock"
              tone={totals.overdueAccounts > 0 ? "danger" : "success"}
              label="Overdue accounts"
              value={count(totals.overdueAccounts)}
              note="Owing longer than their days to pay"
              onClick={() => {
                setTab("accounts");
                setFilter("overdue");
              }}
            />
            <StatTile
              icon="alert"
              tone={old > 0 ? "warning" : "neutral"}
              label="Older than 60 days"
              value={m(old)}
              note={`Over 90 days: ${m(totals.over90)}`}
            />
            <StatTile
              icon="receipt"
              tone="info"
              label="Unpaid, on no account"
              value={m(data.loose.due)}
              note={`${count(data.loose.count)} bill${data.loose.count === 1 ? "" : "s"}`}
              onClick={() => setTab("unpaid")}
            />
          </div>

          <MoneyTabs
            label="Show"
            active={["unpaid", ...(advancesOn ? ["advances"] : [])].includes(tab) ? tab : "accounts"}
            onChange={setTab}
            tabs={[
              { key: "accounts", label: "Accounts", icon: "users", count: count(data.accounts.length) },
              { key: "unpaid", label: "Unpaid, no account", icon: "receipt", count: count(data.loose.count) },
              ...(advancesOn ? [{ key: "advances", label: "Advances", icon: "wallet" }] : []),
            ]}
          />

          {tab === "advances" && advancesOn ? (
            <AdvancesPanel currency={currency} heldTotal={n(totals.advanceHeld)} onChanged={load} />
          ) : tab === "unpaid" ? (
            <LooseBills data={data} currency={currency} />
          ) : (
            <SectionCard
              icon="users"
              title="Accounts"
              description={`What each owes, by age of the bill, as of ${dateText(data.asOf)}.`}
              flush
            >
              <div className="money-filterbar dues-filterbar">
                <div className="segmented" role="radiogroup" aria-label="Which accounts">
                  {[
                    ["owing", "Owing"],
                    ["overdue", "Overdue"],
                    ["all", "All accounts"],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      role="radio"
                      aria-checked={filter === value}
                      className={`segment ${filter === value ? "is-active" : ""}`}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="muted small dues-help">
                  Ageing counts from the bill&apos;s business day. Money collected pays the oldest bills first.
                </p>
              </div>

              <DataGrid
                id="dues-accounts"
                caption="Accounts and what each owes"
                columns={accountColumns}
                rows={accounts}
                rowKey={(row) => row.customerId}
                currency={currency}
                rowNoun={["account", "accounts"]}
                empty={
                  filter === "owing"
                    ? "Nobody owes anything on account."
                    : filter === "overdue"
                      ? "No account is overdue."
                      : "No accounts yet."
                }
                emptyIcon="users"
                emptyHint={
                  data.accounts.length === 0
                    ? "Open an account for a regular or a company (with a credit limit), then put their bills on it from the bill."
                    : "Pick All accounts to see every account."
                }
                emptyAction={
                  canOpenAccount && data.accounts.length === 0 ? (
                    <button type="button" className="button" onClick={() => setEditing({ isNew: true })}>
                      Open an account
                    </button>
                  ) : null
                }
                rowClassName={(row) =>
                  row.hasAccount && row.status !== "active"
                    ? "dg-tone-danger"
                    : row.outstanding > 0 && row.creditDays !== null && daysSince(row.oldestDue, data.asOf) > row.creditDays
                      ? "dg-tone-warning"
                      : ""
                }
                exportName="dues-accounts"
              />
            </SectionCard>
          )}
        </>
      )}

      {editing && (
        <AccountForm
          account={editing.isNew ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={done}
        />
      )}
      {collecting && (
        <CollectForm account={collecting} currency={currency} onClose={() => setCollecting(null)} onSaved={done} />
      )}
      {viewing && (
        <StatementModal account={viewing} currency={currency} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

// Bills left unpaid that are on nobody's account.
function LooseBills({ data, currency }) {
  const bills = data.loose.bills;

  return (
    <SectionCard
      icon="receipt"
      tone="warning"
      title="Unpaid bills on no account"
      description="Guests who left owing, and bills carried over at the close. Open one to take the money or put it on an account."
      flush
    >
      <DataGrid
        id="dues-unpaid"
        caption="Unpaid bills on no account"
        columns={[
          { key: "bill", header: "Bill", value: (row) => row.billNumber, mobile: "title", render: (row) => <span className="mono nowrap">{row.billNumber}</span> },
          { key: "day", header: "Business day", type: "date", value: (row) => row.businessDate, mobile: "show" },
          {
            key: "guest",
            header: "Guest",
            value: (row) => row.guestName || "Walk-in",
            mobile: "show",
            render: (row) => (
              <>
                {row.guestName || <span className="muted">Walk-in</span>}
                {row.tableNo ? <span className="muted small"> · {row.tableNo}</span> : null}
              </>
            ),
          },
          { key: "outlet", header: "Outlet", value: (row) => row.outletName || "Main counter", filter: "select" },
          { key: "total", header: "Bill", type: "money", exact: true, value: (row) => row.totalAmount, total: "sum" },
          {
            key: "due",
            header: "Due",
            type: "money",
            exact: true,
            value: (row) => row.due,
            total: "sum",
            mobile: "show",
            render: (row) => <strong className="dues-owes">{moneyExact(row.due, currency)}</strong>,
          },
          {
            key: "age",
            header: "Age",
            type: "number",
            value: (row) => row.ageDays,
            mobile: "subtitle",
            render: (row) => (
              <Status tone={row.ageDays > 60 ? "danger" : row.ageDays > 30 ? "warning" : "info"}>
                {row.ageDays === 0 ? "Today" : `${row.ageDays} day${row.ageDays === 1 ? "" : "s"}`}
              </Status>
            ),
          },
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (row) => (
              <Link className="button button-ghost button-sm" to={`/bills?bill=${row.billId}`}>
                Open bill
              </Link>
            ),
          },
        ]}
        rows={bills}
        rowKey={(row) => row.billId}
        currency={currency}
        rowNoun={["bill", "bills"]}
        empty="Every unpaid bill is on an account."
        emptyHint="Nothing is owed outside the accounts."
        emptyIcon="check"
        defaultSort={{ key: "age", direction: "desc" }}
        exportName="unpaid-bills"
      />
    </SectionCard>
  );
}

// Opens an account (choose the guest or company) or changes one.
function AccountForm({ account, currency, onClose, onSaved }) {
  const [guest, setGuest] = useState(account);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [form, setForm] = useState(() => ({
    creditLimit: account && account.creditLimit !== null ? String(account.creditLimit) : "",
    creditDays: account && account.creditDays !== null ? String(account.creditDays) : "30",
    status: (account && account.status) || "active",
    notes: (account && account.notes) || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (account || query.trim().length < 2) {
      return undefined;
    }

    const timer = setTimeout(() => {
      searchGuests(query.trim(), 8)
        .then((found) => setMatches(found.items || found.rows || []))
        .catch((err) => setError(getErrorMessage(err)));
    }, 250);

    return () => clearTimeout(timer);
  }, [query, account]);

  const save = (event) => {
    event.preventDefault();

    if (!guest) {
      setError("Choose the guest or company first");
      return;
    }

    setBusy(true);
    setError("");
    saveAccount(guest.customerId || guest.id, {
      creditLimit: Number(form.creditLimit),
      creditDays: form.creditDays === "" ? null : Number(form.creditDays),
      status: form.status,
      notes: form.notes.trim() || null,
    })
      .then((result) => onSaved(result.message))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setBusy(false));
  };

  const name = guest ? guest.name || guest.companyName : "";

  return (
    <Modal
      title={account ? `${account.name}'s account` : "Open an account"}
      description="Bills can go on the account up to its credit limit. Dues older than the days to pay show as overdue."
      icon="users"
      onClose={onClose}
      width={560}
    >
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        {!account && (
          <div className="field">
            <span>Guest or company *</span>
            {guest ? (
              <div className="dues-picked">
                <span>
                  <strong>{name}</strong>
                  {guest.mobile ? <span className="muted small"> · {guest.mobile}</span> : null}
                </span>
                <button type="button" className="button button-ghost button-sm" onClick={() => setGuest(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  type="search"
                  value={query}
                  autoFocus
                  placeholder="Search the guest book: name, company or mobile"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {matches.length > 0 && (
                  <ul className="dues-matches">
                    {matches.map((row) => (
                      <li key={row.id}>
                        <button type="button" onClick={() => setGuest({ ...row, customerId: row.id })}>
                          <strong>{row.companyName || row.name}</strong>
                          <span className="muted small">
                            {row.companyName ? `${row.name} · ` : ""}
                            {row.mobile || ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <small className="muted">Not in the guest book yet? Add them under Guests first.</small>
              </>
            )}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Credit limit ({currency}) *</span>
            <input
              type="number"
              min="0"
              step="1"
              required
              value={form.creditLimit}
              onChange={(event) => setForm({ ...form, creditLimit: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Days to pay</span>
            <input
              type="number"
              min="0"
              max="365"
              step="1"
              value={form.creditDays}
              onChange={(event) => setForm({ ...form, creditDays: event.target.value })}
            />
          </label>
        </div>
        {account && (
          <label className="field">
            <span>Status</span>
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="active">Active — bills can go on it</option>
              <option value="on_hold">On hold — no new bills until it is settled</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Notes</span>
          <input
            value={form.notes}
            maxLength={300}
            placeholder="Who may sign for it, billing contact…"
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />
        </label>
        {account && account.outstanding > 0 && Number(form.creditLimit) < account.outstanding && (
          <p className="small text-danger">
            They owe {moneyExact(account.outstanding, currency)} now: a lower limit stops new bills until they pay.
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || (!account && !guest)}>
            {busy ? "Saving…" : account ? "Save" : "Open account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Money received against an account: paid onto the oldest bills first, into
// today's business day of the till taking it (the outlet chosen in the top
// bar, or the main counter) — the drawer the cash actually goes in.
function CollectForm({ account, currency, onClose, onSaved }) {
  const [bills, setBills] = useState(null);
  const [till, setTill] = useState(null);
  const [form, setForm] = useState({ amount: String(account.outstanding), method: "cash", reference: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getAccountBills(account.customerId)
      .then(setBills)
      .catch((err) => setError(getErrorMessage(err)));
    // This till's own day (scope "counter"): where the money will go.
    getDaySummary({ scope: "counter" })
      .then((summary) => {
        const day = (summary.days || [])[0] || null;
        setTill({ open: Boolean(summary.dayOpen && day), name: day ? day.outletName || "Main counter" : null, date: day ? day.businessDate : null });
      })
      .catch(() => setTill({ open: true, name: null, date: null }));
  }, [account.customerId]);

  // How the money will be paid onto the bills, oldest first, to the paisa.
  const plan = useMemo(
    () =>
      (bills || []).reduce(
        (result, bill) => {
          const due = Math.round(bill.due * 100);
          const part = Math.max(0, Math.min(due, result.left));
          return { left: result.left - part, rows: [...result.rows, { ...bill, part: part / 100 }] };
        },
        { left: Math.round(Number(form.amount || 0) * 100), rows: [] }
      ).rows,
    [bills, form.amount]
  );

  const submit = (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    collectOnAccount(account.customerId, {
      amount: Number(form.amount),
      paymentMethod: form.method,
      transactionRef: form.method !== "cash" && form.reference.trim() ? form.reference.trim() : null,
    })
      .then((result) => onSaved(result.message))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setBusy(false));
  };

  const amount = Number(form.amount || 0);

  return (
    <Modal
      title={`Collect from ${account.name}`}
      description={`Owes ${moneyExact(account.outstanding, currency)}. Paid onto the oldest bills first.`}
      icon="wallet"
      onClose={onClose}
      width={600}
    >
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        {till && till.open && till.name && (
          <p className="dues-till small">
            <Icon name="wallet" size={14} />
            <span>
              Goes into <strong>{till.name}</strong>&apos;s business day
              {till.date ? ` · ${dateText(till.date)}` : ""} — the drawer of this till.
            </span>
          </p>
        )}
        {till && !till.open && (
          <p className="alert alert-notice small">
            No business day is open at this till. Open the day first, or pick the outlet you are at in the top bar:
            the money goes into the drawer of the till taking it.
          </p>
        )}
        <div className="segmented bill-methods" role="radiogroup" aria-label="Paid by">
          {QUICK_METHODS.map((method) => (
            <button
              type="button"
              key={method}
              role="radio"
              aria-checked={form.method === method}
              className={`segment ${form.method === method ? "is-active" : ""}`}
              onClick={() => setForm({ ...form, method })}
            >
              {paymentMethodLabel(method)}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Amount ({currency}) *</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={account.outstanding}
              required
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
            />
          </label>
          {form.method !== "cash" && (
            <label className="field">
              <span>Reference</span>
              <input
                value={form.reference}
                maxLength={100}
                placeholder="UTR, cheque or card slip"
                onChange={(event) => setForm({ ...form, reference: event.target.value })}
              />
            </label>
          )}
        </div>
        {bills === null ? (
          <Loading label="Reading the bills…" />
        ) : (
          <div className="dues-plan">
            <p className="small muted">Paid onto these bills, oldest first:</p>
            <ul>
              {plan.map((bill) => (
                <li key={bill.billId} className={bill.part > 0 ? "is-paid" : ""}>
                  <span>
                    <span className="mono">{bill.billNumber}</span>
                    <span className="muted small">
                      {" "}
                      · {dateText(bill.businessDate)}
                      {bill.outletName ? ` · ${bill.outletName}` : ""}
                    </span>
                  </span>
                  <span className="dues-plan-figures">
                    <span className="muted small">due {moneyExact(bill.due, currency)}</span>
                    <strong>{bill.part > 0 ? moneyExact(bill.part, currency) : "—"}</strong>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {amount > account.outstanding + 0.009 && (
          <p className="small text-danger">That is more than {account.name} owes.</p>
        )}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button"
            disabled={busy || !(amount > 0) || amount > account.outstanding + 0.009 || (till && !till.open)}
          >
            {busy ? "Saving…" : `Collect ${moneyExact(amount, currency)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const KIND_WORDS = { bill: "Bill", payment: "Payment", refund: "Money back", credit_note: "Credit note" };

// An account's statement: opening balance, every bill and payment, and the
// running balance; printable for the company and downloadable for the
// accountant.
function StatementModal({ account, currency, onClose }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getStatement(account.customerId, {
      from: range.from || undefined,
      to: range.to || undefined,
    })
      .then((loaded) => {
        setData(loaded);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [account.customerId, range.from, range.to]);

  const mx = (value) => moneyExact(value, currency);

  const download = () =>
    downloadCsv(
      [
        ["Statement", data.name],
        ["Period", data.from || "start", data.to || "today"],
        [],
        ["Date", "Kind", "Reference", "Description", "Debit", "Credit", "Balance"],
        ["", "", "", "Opening balance", "", "", data.openingBalance.toFixed(2)],
        ...data.entries.map((row) => [
          row.date,
          KIND_WORDS[row.kind] || row.kind,
          row.reference || "",
          row.description,
          row.debit ? row.debit.toFixed(2) : "",
          row.credit ? row.credit.toFixed(2) : "",
          row.balance.toFixed(2),
        ]),
        ["", "", "", "Closing balance", data.totals.debit.toFixed(2), data.totals.credit.toFixed(2), data.closingBalance.toFixed(2)],
      ],
      `statement-${data.name.replace(/[^A-Za-z0-9]+/g, "-")}.csv`
    );

  const print = () =>
    printDocument({
      title: `Statement · ${data.name}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #000; margin: 24px; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        table { border-collapse: collapse; width: 100%; margin-top: 12px; }
        th, td { border-bottom: 1px solid #ccc; padding: 5px 6px; text-align: left; vertical-align: top; }
        .r { text-align: right; white-space: nowrap; }
        tfoot td { font-weight: bold; border-top: 2px solid #000; }
      `,
      body: `
        <h1>Statement of account · ${escapeHtml(data.name)}</h1>
        <div>${data.gstin ? `GSTIN ${escapeHtml(data.gstin)} · ` : ""}${escapeHtml(data.from || "From the first bill")} to ${escapeHtml(
          data.to || "today"
        )}</div>
        <table>
          <thead><tr><th>Date</th><th>Particulars</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
          <tbody>
            <tr><td></td><td>Opening balance</td><td></td><td></td><td class="r">${escapeHtml(mx(data.openingBalance))}</td></tr>
            ${data.entries
              .map(
                (row) =>
                  `<tr><td>${escapeHtml(dateText(row.date))}</td><td>${escapeHtml(row.description)}</td><td class="r">${
                    row.debit ? escapeHtml(mx(row.debit)) : ""
                  }</td><td class="r">${row.credit ? escapeHtml(mx(row.credit)) : ""}</td><td class="r">${escapeHtml(mx(row.balance))}</td></tr>`
              )
              .join("")}
          </tbody>
          <tfoot><tr><td></td><td>Closing balance</td><td class="r">${escapeHtml(mx(data.totals.debit))}</td><td class="r">${escapeHtml(
            mx(data.totals.credit)
          )}</td><td class="r">${escapeHtml(mx(data.closingBalance))}</td></tr></tfoot>
        </table>
      `,
    });

  return (
    <Modal
      title={`Statement · ${account.name}`}
      description="Every bill put on the account, every payment against it, and what was owed after each."
      icon="file"
      onClose={onClose}
      width={880}
      footer={
        data ? (
          <>
            <button type="button" className="button button-secondary" onClick={download}>
              <Icon name="download" size={16} /> CSV
            </button>
            <button type="button" className="button" onClick={print}>
              <Icon name="print" size={16} /> Print
            </button>
          </>
        ) : null
      }
    >
      <div className="stack">
        <div className="filters dues-range">
          <label className="field">
            <span>From</span>
            <input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} />
          </label>
        </div>
        <ErrorMessage message={error} />
        {!data ? (
          <Loading label="Reading the statement…" />
        ) : (
          <>
            <div className="dues-statement-head">
              <span>
                Opening <strong>{mx(data.openingBalance)}</strong>
              </span>
              <span>
                Billed <strong>{mx(data.totals.debit)}</strong>
              </span>
              <span>
                Received <strong>{mx(data.totals.credit)}</strong>
              </span>
              <span>
                Closing <strong className={data.closingBalance > 0 ? "dues-owes" : ""}>{mx(data.closingBalance)}</strong>
              </span>
            </div>
            <DataGrid
              id="dues-statement"
              caption={`Statement of ${data.name}`}
              variant="compact"
              columns={[
                { key: "date", header: "Date", type: "date", value: (row) => row.date, mobile: "title" },
                {
                  key: "particulars",
                  header: "Particulars",
                  value: (row) => row.description,
                  mobile: "subtitle",
                  render: (row) => (
                    <span>
                      <span className="muted small">{KIND_WORDS[row.kind] || row.kind} · </span>
                      {row.description}
                    </span>
                  ),
                },
                { key: "debit", header: "Debit", type: "money", exact: true, value: (row) => row.debit || null, total: "sum", mobile: "show" },
                { key: "credit", header: "Credit", type: "money", exact: true, value: (row) => row.credit || null, total: "sum", mobile: "show" },
                {
                  key: "balance",
                  header: "Balance",
                  type: "money",
                  exact: true,
                  value: (row) => row.balance,
                  mobile: "show",
                  render: (row) => <strong>{mx(row.balance)}</strong>,
                },
              ]}
              rows={data.entries}
              rowKey={(row, index) => `${row.kind}-${row.reference}-${index}`}
              currency={currency}
              rowNoun={["entry", "entries"]}
              empty="Nothing in this period."
              emptyHint="Widen the dates, or clear them for the whole history."
              emptyIcon="file"
            />
            {data.advances && data.advances.items.length > 0 && (
              <div className="dues-advances-held">
                <p className="small">
                  <strong>Advances paid ahead:</strong> {mx(data.advances.held)} held for {data.name}, apart from what
                  is owed. It is used on a bill (Pay from advance) or handed back.
                </p>
                <ul>
                  {data.advances.items.map((row) => (
                    <li key={row.id}>
                      <span className="mono">{row.receiptNumber}</span> · {dateText(row.businessDate)} · {mx(row.amount)}
                      {row.used > 0 ? ` · used ${mx(row.used)}` : ""}
                      {row.refunded > 0 ? ` · handed back ${mx(row.refunded)}` : ""}
                      {" · "}
                      <strong>{mx(row.held)} held</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
