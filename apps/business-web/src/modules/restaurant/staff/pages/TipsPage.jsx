import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import LiveValue from "../../../../components/LiveValue";
import SuccessCheck from "../../../../components/SuccessCheck";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { confirmShareout, getTips, previewShareout, saveTipSettings, undoShareout } from "../services/tip.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart, today } from "@bmp/shared/dates";
import { count, money, moneyExact } from "@bmp/shared/format";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import "../../../../styles/access.css";
import "../../../../styles/access-sweep.css";

// Staff -> Tips. Tips are taken at payment (the billing screen's tip box);
// here a manager sees them by day and by person, shares a period's pool out
// between the people who worked it, and the shares are paid with salary as a
// separate "Tips" line.

const lastMonth = () => {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString("en-CA"),
    to: new Date(now.getFullYear(), now.getMonth(), 0).toLocaleDateString("en-CA"),
  };
};

const PERIODS = [
  { key: "this", label: "This month", range: () => ({ from: monthStart(), to: today() }) },
  { key: "last", label: "Last month", range: lastMonth },
];

const dayLabel = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

const shortDate = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const hours = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

const BASIS = {
  hours: { label: "Hours worked", hint: "From the attendance sheet: more hours, bigger share" },
  points: { label: "Points × days", hint: "Points per designation, times the days each person worked" },
};

const TABS = [
  { key: "days", label: "By day", icon: "calendar" },
  { key: "people", label: "By person", icon: "users" },
  { key: "shareouts", label: "Share-outs", icon: "history" },
];

const urlDate = (key) => {
  try {
    const value = new URLSearchParams(window.location.search).get(key);
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
};

export default function TipsPage() {
  const [tab, setTab] = useQueryFilter("tab", "days");
  // Payroll's "Tips waiting to share" link opens the period being paid
  // (?from=…&to=…); otherwise this month.
  const [from, setFrom] = useState(() => urlDate("from") || monthStart());
  const [to, setTo] = useState(() => urlDate("to") || today());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [sharing, setSharing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [undoing, setUndoing] = useState(null);
  const [busy, setBusy] = useState(false);
  // The restaurant's symbol for the grids' money cells and totals.
  const [currency, setCurrency] = useState("₹");

  const load = useCallback(
    () =>
      getTips({ from, to })
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [from, to]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, []);

  const activePeriod = PERIODS.find((period) => {
    const range = period.range();
    return range.from === from && range.to === to;
  });

  const runUndo = async () => {
    setBusy(true);

    try {
      const result = await undoShareout(undoing.id);
      setSuccess(result.message);
      setUndoing(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setUndoing(null);
    } finally {
      setBusy(false);
    }
  };


  const totals = data?.totals;
  const tabs = TABS.map((item) => ({
    ...item,
    count: item.key === "days" ? data?.days.length : item.key === "people" ? data?.people.length : data?.shareouts.length,
  }));

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="wallet"
        title="Tips"
        description="Tips taken at payment, shared out to the people who worked the shift, and paid with their salary as a separate line."
        action={
          <div className="asw-header-actions">
            <button type="button" className="button button-secondary" onClick={() => setSettingsOpen(true)} disabled={!data}>
              <Icon name="sliders" size={16} /> How tips are shared
            </button>
            <button type="button" className="button" onClick={() => setSharing(true)} disabled={!data}>
              <Icon name="users" size={16} /> Share out tips
            </button>
          </div>
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <div className="card acc-toolbar">
        <div className="filters">
          <label className="field">
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={to} min={from} max={today()} onChange={(event) => setTo(event.target.value)} />
          </label>
          <div className="field">
            <span>Period</span>
            <div className="segmented" role="radiogroup" aria-label="Period">
              {PERIODS.map((period) => (
                <button
                  key={period.key}
                  type="button"
                  role="radio"
                  aria-checked={activePeriod?.key === period.key}
                  className={`segment ${activePeriod?.key === period.key ? "is-active" : ""}`}
                  onClick={() => {
                    const range = period.range();
                    setFrom(range.from);
                    setTo(range.to);
                  }}
                >
                  {period.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {!data ? (
        error ? null : <Loading label="Loading tips…" />
      ) : (
        <>
          <div className="stat-grid">
            <StatTile
              icon="wallet"
              tone="primary"
              label="Tips collected"
              value={money(totals.tips)}
              note={`${count(totals.count)} tip${totals.count === 1 ? "" : "s"} · cash ${money(totals.cash)} · card ${money(totals.card)} · UPI ${money(totals.upi)}`}
            />
            {data.settings.includeServiceCharge && (
              <StatTile icon="percent" tone="info" label="Service charge" value={money(totals.serviceCharge)} note="joins the pool" />
            )}
            <StatTile icon="check-circle" tone="success" label="Shared out" value={money(totals.shared)} note="on payroll as Tips" />
            <StatTile
              icon="timer"
              tone={totals.unshared > 0 ? "warning" : "neutral"}
              label="Waiting to share"
              value={money(totals.unshared)}
              note={totals.unshared > 0 ? "share it out before payroll" : "nothing waiting"}
            />
          </div>

          <p className="muted small asw-rule-line">
            <Icon name="info" size={14} />{" "}
            {data.settings.routing === "captain"
              ? "A tip on an order a captain took goes straight to that captain; every other tip goes into the day's pool."
              : "Every tip goes into the day's pool."}{" "}
            The pool is shared by {data.settings.shareBasis === "hours" ? "hours worked" : "points per designation × days worked"}.
            Tips are never part of sales, GST, discounts or loyalty points.
          </p>

          <div className="acc-tabs" role="tablist" aria-label="Tips views" data-motion-tabs>
            {tabs.map((item) => (
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
                {item.count !== undefined && <span className="acc-tab-count">{count(item.count)}</span>}
              </button>
            ))}
          </div>

          {tab === "days" && <DaysTable data={data} currency={currency} />}
          {tab === "people" && <PeopleTable data={data} currency={currency} />}
          {tab === "shareouts" && <ShareoutsTable data={data} currency={currency} onView={setViewing} onUndo={setUndoing} />}
        </>
      )}

      {sharing && (
        <ShareOutModal
          initialFrom={from}
          initialTo={to}
          onClose={() => setSharing(false)}
          onDone={(message) => {
            setSuccess(message);
            setTab("shareouts");
            load();
          }}
        />
      )}

      {settingsOpen && data && (
        <SettingsModal
          settings={data.settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            setSuccess("Saved. The next share-out follows these rules.");
            load();
          }}
        />
      )}

      {viewing && <ShareoutModal shareout={viewing} onClose={() => setViewing(null)} />}

      {undoing && (
        <ConfirmDialog
          title="Undo share-out"
          message={`Undo the share-out of ${moneyExact(undoing.total)} for ${shortDate(undoing.from)} to ${shortDate(undoing.to)}? The shares come off payroll and the tips can be shared again. This is written to the activity log.`}
          confirmLabel="Undo share-out"
          onConfirm={runUndo}
          onCancel={() => setUndoing(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

// The badge for how much of a day's tips have been shared out.
function SharedBadge({ row }) {
  if (row.unshared === 0) {
    return (
      <span className="badge badge-active status-badge">
        <span className="badge-dot" aria-hidden="true" />
        Shared
      </span>
    );
  }

  return (
    <span className="badge badge-warning status-badge">
      <span className="badge-dot" aria-hidden="true" />
      {row.shared === 0 ? "Waiting" : `${moneyExact(row.unshared)} waiting`}
    </span>
  );
}

const sharedWord = (row) => (row.unshared === 0 ? "Shared" : row.shared === 0 ? "Waiting" : "Part shared");

// An amount, or a dash when there is none (easier to scan down a column).
const amountOrDash = (value) => (value ? moneyExact(value) : <span className="muted">—</span>);

function DaysTable({ data, currency }) {
  const columns = [
    {
      key: "date",
      header: "Day",
      type: "date",
      value: (row) => row.date,
      mobile: "title",
      pin: true,
      csv: (row) => row.date,
      render: (row) => <strong className="nowrap">{dayLabel(row.date)}</strong>,
    },
    { key: "count", header: "Tips", type: "number", value: (row) => row.count, total: "sum", mobile: "show" },
    {
      key: "cash",
      header: "Cash",
      type: "money",
      exact: true,
      value: (row) => row.byMethod.cash || 0,
      total: "sum",
      mobile: "show",
      render: (row) => amountOrDash(row.byMethod.cash),
    },
    {
      key: "card",
      header: "Card",
      type: "money",
      exact: true,
      value: (row) => row.byMethod.card || 0,
      total: "sum",
      render: (row) => amountOrDash(row.byMethod.card),
    },
    {
      key: "upi",
      header: "UPI",
      type: "money",
      exact: true,
      value: (row) => row.byMethod.upi || 0,
      total: "sum",
      render: (row) => amountOrDash(row.byMethod.upi),
    },
    data.days.some((row) => row.byMethod.other) && {
      key: "other",
      header: "Other",
      type: "money",
      exact: true,
      value: (row) => row.byMethod.other || 0,
      total: "sum",
      render: (row) => amountOrDash(row.byMethod.other),
    },
    data.settings.includeServiceCharge && {
      key: "serviceCharge",
      header: "Service charge",
      type: "money",
      exact: true,
      value: (row) => row.serviceCharge || 0,
      total: "sum",
      render: (row) => amountOrDash(row.serviceCharge),
    },
    {
      key: "total",
      header: "Total",
      type: "money",
      exact: true,
      value: (row) => row.tips + row.serviceCharge,
      total: "sum",
      mobile: "show",
      render: (row) => <strong>{moneyExact(row.tips + row.serviceCharge)}</strong>,
    },
    {
      key: "waiting",
      header: "Waiting",
      type: "money",
      exact: true,
      value: (row) => row.unshared,
      total: "sum",
      mobile: "show",
      render: (row) => amountOrDash(row.unshared),
    },
    {
      key: "shared",
      header: "Shared",
      type: "status",
      value: (row) => sharedWord(row),
      mobile: "subtitle",
      render: (row) => <SharedBadge row={row} />,
    },
  ];

  return (
    <SectionCard icon="calendar" title="Tips by day" description="Each day's tips by how they were paid, and whether they have been shared." flush>
      <DataGrid
        id="tips-by-day"
        caption="Tips by day"
        columns={columns}
        rows={data.days}
        rowKey={(row) => row.date}
        currency={currency}
        empty="No tips in this period"
        emptyIcon="wallet"
        emptyHint="Tips are added when a payment is taken on the billing screen. They show here by day."
        rowClassName={(row) => (row.unshared > 0 ? "dg-tone-warning" : "")}
        exportName="tips-by-day"
      />
    </SectionCard>
  );
}

function PeopleTable({ data, currency }) {
  const total = data.people.reduce((sum, row) => sum + row.total, 0);
  const columns = [
    {
      key: "name",
      header: "Person",
      value: (row) => row.name,
      mobile: "title",
      pin: true,
      render: (row) => (
        <span className="acc-who-text">
          <strong>{row.name}</strong>
          <span className="muted small">{row.designation || "—"}</span>
        </span>
      ),
    },
    { key: "designation", header: "Designation", value: (row) => row.designation || "", defaultHidden: true, mobile: "subtitle" },
    { key: "direct", header: "On their orders", type: "money", exact: true, value: (row) => row.direct || 0, total: "sum", mobile: "show" },
    { key: "pool", header: "From the pool", type: "money", exact: true, value: (row) => row.pool || 0, total: "sum", mobile: "show" },
    {
      key: "total",
      header: "Tips on payroll",
      type: "money",
      exact: true,
      value: (row) => row.total,
      total: "sum",
      mobile: "show",
      render: (row) => <strong>{moneyExact(row.total)}</strong>,
    },
  ];

  return (
    <SectionCard
      icon="users"
      title="Tips by person"
      description="Shares landing in this period's pay: straight to a captain, and from the pool."
      actions={data.people.length > 0 ? <span className="acc-count">{moneyExact(total)} in all</span> : null}
      flush
    >
      <DataGrid
        id="tips-by-person"
        caption="Tips by person"
        columns={columns}
        rows={data.people}
        rowKey={(row) => row.employeeId}
        currency={currency}
        empty="No tips shared out to anyone in this period yet"
        emptyIcon="users"
        emptyHint="Share out tips to see each person's share here. They are paid with the salary for the period the pay date falls in."
        defaultSort={{ key: "total", direction: "desc" }}
        exportName="tips-by-person"
      />
    </SectionCard>
  );
}

function ShareoutsTable({ data, currency, onView, onUndo }) {
  const columns = [
    {
      key: "period",
      header: "Period",
      type: "date",
      value: (row) => row.from,
      mobile: "title",
      pin: true,
      csv: (row) => `${row.from} to ${row.to}`,
      render: (row) => (
        <span className="acc-who-text">
          <strong>
            {shortDate(row.from)} – {shortDate(row.to)}
          </strong>
          <span className="muted small">
            by {row.createdByName || "—"} · {BASIS[row.basis].label.toLowerCase()}
          </span>
        </span>
      ),
    },
    {
      key: "routing",
      header: "Shared by",
      value: (row) => (row.routing === "captain" ? "Captain first, then pool" : "Pool"),
      mobile: "subtitle",
    },
    {
      key: "tips",
      header: "Tips",
      type: "money",
      exact: true,
      value: (row) => row.tipsTotal,
      total: "sum",
      render: (row) => (
        <>
          {row.tipCount} · {moneyExact(row.tipsTotal)}
          {row.serviceChargeTotal > 0 && <div className="muted small">+ {moneyExact(row.serviceChargeTotal)} service charge</div>}
        </>
      ),
    },
    {
      key: "total",
      header: "Total shared",
      type: "money",
      exact: true,
      value: (row) => row.total,
      total: "sum",
      mobile: "show",
      render: (row) => <strong>{moneyExact(row.total)}</strong>,
    },
    { key: "people", header: "People", type: "number", value: (row) => row.shares.length, mobile: "show" },
    {
      key: "payDate",
      header: "Paid with",
      type: "date",
      value: (row) => row.payDate,
      mobile: "show",
      render: (row) => <span className="small">Pay for {shortDate(row.payDate)}</span>,
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => (
        <div className="row-actions">
          <button type="button" className="chip-button" onClick={() => onView(row)}>
            <Icon name="eye" size={14} /> Shares
          </button>
          <ActionMenu
            label={`More for the share-out of ${shortDate(row.from)} – ${shortDate(row.to)}`}
            items={[{ label: "Undo share-out", icon: "undo", danger: true, onClick: () => onUndo(row) }]}
          />
        </div>
      ),
    },
  ];

  return (
    <SectionCard icon="history" title="Share-outs" description="Each one as it was confirmed. Undo is possible until that pay is marked paid." flush>
      <DataGrid
        id="tips-shareouts"
        caption="Tip share-outs"
        columns={columns}
        rows={data.shareouts}
        rowKey={(row) => row.id}
        currency={currency}
        empty="No share-outs in this period"
        emptyIcon="history"
        emptyHint="Share out tips to split a period's pool between the people who worked it."
        exportName="tip-shareouts"
      />
    </SectionCard>
  );
}

function ShareoutModal({ shareout, onClose }) {
  return (
    <Modal
      title={`Share-out · ${shortDate(shareout.from)} – ${shortDate(shareout.to)}`}
      description={`${moneyExact(shareout.total)} shared on ${new Date(shareout.createdAt).toLocaleString("en-IN")} by ${shareout.createdByName || "—"}.`}
      icon="users"
      onClose={onClose}
      width={620}
    >
      <ShareList direct={shareout.shares.filter((row) => row.kind === "direct")} pool={shareout.shares.filter((row) => row.kind === "pool")} basis={shareout.basis} />
    </Modal>
  );
}

// Each person's share: straight from their orders, and from the pool.
function ShareList({ direct, pool, basis }) {
  return (
    <div className="stack asw-share-list">
      {direct.length > 0 && (
        <div>
          <p className="section-heading">Straight to the captain</p>
          <ul className="asw-share-rows">
            {direct.map((row) => (
              <li key={`d-${row.employeeId}`}>
                <span>
                  <strong>{row.name}</strong>
                  <small className="muted">{row.tips ? `${row.tips} tip${row.tips === 1 ? "" : "s"} on orders they took` : "tips on orders they took"}</small>
                </span>
                <strong className="asw-share-amount">{moneyExact(row.amount)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="section-heading">From the pool · by {BASIS[basis].label.toLowerCase()}</p>
        {pool.length === 0 ? (
          <p className="muted small">Nothing went into the pool.</p>
        ) : (
          <ul className="asw-share-rows">
            {pool.map((row) => (
              <li key={`p-${row.employeeId}`}>
                <span>
                  <strong>{row.name}</strong>
                  <small className="muted">
                    {row.designation ? `${row.designation} · ` : ""}
                    {basis === "hours" ? hours(row.workedMinutes) : `${row.points} pts × ${row.daysWorked} days`}
                    {row.sharePercent !== undefined ? ` · ${row.sharePercent}%` : ""}
                  </small>
                </span>
                <strong className="asw-share-amount">{moneyExact(row.amount)}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ShareOutModal({ initialFrom, initialTo, onClose, onDone }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo > today() ? today() : initialTo);
  const [payDate, setPayDate] = useState("");
  const [basis, setBasis] = useState(null);
  const [excluded, setExcluded] = useState([]);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;

    previewShareout({
      from,
      to,
      payDate: payDate || undefined,
      basis: basis || undefined,
      excludeEmployeeIds: excluded.map((person) => person.id),
    })
      .then((result) => {
        if (alive) {
          setPreview(result);
          setError("");
          if (!basis) {
            setBasis(result.basis);
          }
        }
      })
      .catch((err) => {
        if (alive) {
          setPreview(null);
          setError(getErrorMessage(err));
        }
      });

    return () => {
      alive = false;
    };
  }, [from, to, payDate, basis, excluded]);

  const total = preview ? Math.round((preview.tipsTotal + preview.serviceChargeTotal) * 100) / 100 : 0;

  // Everyone the pool could go to: the people in it now, and anyone left out.
  const people = useMemo(() => {
    if (!preview) {
      return [];
    }

    return preview.pool;
  }, [preview]);

  const confirm = async () => {
    setBusy(true);
    setError("");

    try {
      const result = await confirmShareout({
        from,
        to,
        payDate: payDate || undefined,
        basis,
        excludeEmployeeIds: excluded.map((person) => person.id),
        expectedTotal: total,
      });
      setDone(result);
      onDone(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal title="Tips shared" icon="check-circle" onClose={onClose} width={560}>
        <div className="stack">
          <div className="asw-done">
            <SuccessCheck size={48} label="Tips shared" />
            <div>
              <strong>{moneyExact(done.data.total)} shared between {done.data.shares.length} {done.data.shares.length === 1 ? "person" : "people"}.</strong>
              <p className="muted small">{done.message}</p>
            </div>
          </div>
          <ShareList direct={done.data.shares.filter((row) => row.kind === "direct")} pool={done.data.shares.filter((row) => row.kind === "pool")} basis={done.data.basis} />
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Share out tips"
      description="Check every share before you confirm. The shares always add up exactly to the money being shared."
      icon="users"
      onClose={onClose}
      width={720}
    >
      <div className="stack">
        <div className="form-grid">
          <label className="field">
            <span>Tips from</span>
            <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={to} min={from} max={today()} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="field">
            <span>Pay with salary for</span>
            <input type="date" value={payDate || to} min={from} onChange={(event) => setPayDate(event.target.value)} />
            <small className="muted">The shares land in the pay period holding this day</small>
          </label>
          <div className="field">
            <span>Share the pool by</span>
            <div className="segmented" role="radiogroup" aria-label="Share the pool by">
              {Object.entries(BASIS).map(([key, item]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={basis === key}
                  className={`segment ${basis === key ? "is-active" : ""}`}
                  onClick={() => setBasis(key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {basis && <small className="muted">{BASIS[basis].hint}</small>}
          </div>
        </div>

        <ErrorMessage message={error} />

        {!preview ? (
          error ? null : <Loading label="Working out the shares…" />
        ) : total === 0 ? (
          <EmptyState icon="wallet" message="Nothing to share for these days" hint="Either no tips were taken, or they have been shared already." />
        ) : (
          <>
            <div className="asw-share-summary">
              <div>
                <span className="muted small">Tips</span>
                <strong>
                  <LiveValue value={preview.tipsTotal}>{moneyExact(preview.tipsTotal)}</LiveValue>
                </strong>
                <small className="muted">{preview.tipCount} tips</small>
              </div>
              {preview.includeServiceCharge && (
                <div>
                  <span className="muted small">Service charge</span>
                  <strong>{moneyExact(preview.serviceChargeTotal)}</strong>
                  <small className="muted">{preview.billCount} bills</small>
                </div>
              )}
              {preview.directTotal > 0 && (
                <div>
                  <span className="muted small">Straight to captains</span>
                  <strong>{moneyExact(preview.directTotal)}</strong>
                </div>
              )}
              <div className="asw-share-pool">
                <span className="muted small">The pool</span>
                <strong>
                  <LiveValue value={preview.poolTotal}>{moneyExact(preview.poolTotal)}</LiveValue>
                </strong>
                <small className="muted">shared {moneyExact(preview.poolShared)}</small>
              </div>
            </div>

            {preview.warnings.map((warning) => (
              <div key={warning} className="alert" role="alert">
                {warning}
              </div>
            ))}

            <ShareList direct={preview.direct} pool={people} basis={preview.basis} />

            {(people.length > 0 || excluded.length > 0) && (
              <details className="asw-exclude">
                <summary>
                  Who shares the pool ({people.length} in{excluded.length ? `, ${excluded.length} left out` : ""}) — untick to leave someone out
                </summary>
                <div className="asw-exclude-list">
                  {people.map((row) => (
                    <label key={row.employeeId} className="checkbox">
                      <input
                        type="checkbox"
                        checked
                        onChange={() => setExcluded([...excluded, { id: row.employeeId, name: row.name }])}
                      />
                      <span>{row.name}</span>
                    </label>
                  ))}
                  {excluded.map((person) => (
                    <label key={`x-${person.id}`} className="checkbox">
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => setExcluded(excluded.filter((item) => item.id !== person.id))}
                      />
                      <span className="muted">{person.name} — left out</span>
                    </label>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={confirm}
            disabled={busy || !preview || total === 0 || (preview.poolTotal > 0 && preview.pool.length === 0)}
          >
            {busy ? "Sharing…" : `Confirm and share ${moneyExact(total)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SettingsModal({ settings, onClose, onSaved }) {
  const [routing, setRouting] = useState(settings.routing);
  const [includeServiceCharge, setIncludeServiceCharge] = useState(settings.includeServiceCharge);
  const [shareBasis, setShareBasis] = useState(settings.shareBasis);
  const [defaultPoints, setDefaultPoints] = useState(String(settings.defaultPoints));
  const [points, setPoints] = useState(() => {
    const rows = Object.entries(settings.designationPoints || {}).map(([name, value]) => ({ name, value: String(value) }));
    return rows.length ? rows : [{ name: "Captain", value: "3" }, { name: "Steward", value: "2" }, { name: "Helper", value: "1" }];
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await saveTipSettings({
        routing,
        includeServiceCharge,
        shareBasis,
        defaultPoints: Number(defaultPoints || 0),
        designationPoints: Object.fromEntries(
          points.filter((row) => row.name.trim()).map((row) => [row.name.trim(), Number(row.value || 0)])
        ),
      });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="How tips are shared" description="Applies to the next share-out. Shares already confirmed stay as they were." icon="sliders" onClose={onClose} width={620}>
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />

        <fieldset className="asw-choice-group">
          <legend>Who gets a tip</legend>
          <label className={`asw-choice ${routing === "pool" ? "is-checked" : ""}`}>
            <input type="radio" name="routing" checked={routing === "pool"} onChange={() => setRouting("pool")} />
            <span>
              <strong>The day's pool</strong>
              <small className="muted">Every tip is shared between everyone who worked</small>
            </span>
          </label>
          <label className={`asw-choice ${routing === "captain" ? "is-checked" : ""}`}>
            <input type="radio" name="routing" checked={routing === "captain"} onChange={() => setRouting("captain")} />
            <span>
              <strong>The captain who took the order</strong>
              <small className="muted">The rest (counter orders, the owner's) goes into the pool</small>
            </span>
          </label>
        </fieldset>

        <label className="checkbox">
          <input type="checkbox" checked={includeServiceCharge} onChange={(event) => setIncludeServiceCharge(event.target.checked)} />
          <span>Add the service charge collected to the pool</span>
        </label>

        <div className="field">
          <span>Share the pool by</span>
          <div className="segmented" role="radiogroup" aria-label="Share the pool by">
            {Object.entries(BASIS).map(([key, item]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={shareBasis === key}
                className={`segment ${shareBasis === key ? "is-active" : ""}`}
                onClick={() => setShareBasis(key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Points per designation</span>
          <small className="muted">Used when sharing by points: a captain with 3 points who worked 10 days gets 30 parts. 0 leaves a designation out.</small>
          <div className="asw-points">
            {points.map((row, index) => (
              <div key={index} className="asw-points-row">
                <input
                  value={row.name}
                  onChange={(event) => setPoints(points.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)))}
                  placeholder="Designation"
                  maxLength={100}
                  aria-label="Designation"
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={row.value}
                  onChange={(event) => setPoints(points.map((item, at) => (at === index ? { ...item, value: event.target.value } : item)))}
                  aria-label={`Points for ${row.name || "this designation"}`}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setPoints(points.filter((item, at) => at !== index))}
                  aria-label={`Remove ${row.name || "this row"}`}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            ))}
            <button type="button" className="link-button" onClick={() => setPoints([...points, { name: "", value: "1" }])}>
              <Icon name="plus" size={14} /> Add a designation
            </button>
          </div>
          <label className="field asw-default-points">
            <span>Anyone else</span>
            <input type="number" min="0" max="100" step="0.5" value={defaultPoints} onChange={(event) => setDefaultPoints(event.target.value)} />
          </label>
        </div>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
