import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import SuccessCheck from "../../../../components/SuccessCheck";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  getBusinessDay,
  getClosePreview,
  getXReport,
  reopenBusinessDay,
} from "../services/businessDay.service";
import { getDaySummary } from "../../billing/services/bill.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { elapsed } from "@bmp/shared/dates";
import { money, moneyExact } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useShake from "../../../../hooks/useShake";
import CloseDayDialog from "./CloseDayDialog";
import OpenDayDialog from "./OpenDayDialog";
import DrawersPanel from "./DrawersPanel";
import CashRules from "./CashRules";
import PastDays from "./PastDays";
import { varianceWords } from "./cashMath";
import { MoneyTabs, Status } from "./moneyUi";
import { dateText, momentText } from "./moneyText";
import { StaleDayNotice } from "./StaleDay";
import { forgetBusinessDay } from "./staleDayStatus";
import { printXReport } from "./xReport";
import "../../../../styles/billing.css";
import "../../../../styles/cash.css";

// How long a day has been open, in words: "2d 5h" past a day, "5h 12m" under.
const openFor = (since) => {
  const text = elapsed(since);
  const hours = Number((/^(\d+)h/.exec(text) || [])[1] || 0);

  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : text;
};

const varianceClass = (variance) =>
  Math.abs(variance) < 0.005 ? "is-match" : variance < 0 ? "is-short" : "is-over";

export default function BusinessDayPage() {
  const { user, hasPermission, hasFeature } = useAuth();
  const canManage = hasPermission("business_day.manage");
  const canClose = hasPermission("business_day.close");
  const canSeeSales = hasPermission("sales.view");
  const canSetRules = hasPermission("restaurant.settings.manage");
  const canSeeReports = hasPermission("reports.view");

  const [tab, setTab] = useQueryFilter("tab", "day");
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // The day just closed here, shown with its count until the next action.
  const [justClosed, setJustClosed] = useState(null);

  // "open" | "close" | { reopen: day }
  const [dialog, setDialog] = useState(null);
  // The date the Open day dialog starts on.
  const [openDate, setOpenDate] = useState("");
  const [form, setForm] = useState({ businessDate: "", cash: "", notes: "", reason: "" });
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formRef, shakeForm] = useShake();
  // The close was started from "Close <old date> and open today": carry the
  // unpaid bills by default and offer today's day straight after.
  const [staleClose, setStaleClose] = useState(false);
  // A quick action on Today opens its entry on the Drawers tab.
  const [startAction, setStartAction] = useState(null);
  // What the drawer should hold now, for the Today card.
  const [drawerHold, setDrawerHold] = useState(null);
  const [params, setParams] = useSearchParams();
  // Arrived from a red "close the old day" banner elsewhere (?closeStale=1):
  // the close opens once the status says the open day is an old one.
  const wantsStaleClose = useRef(params.get("closeStale") === "1");

  const currency = (settings && settings.currencySymbol) || "₹";

  const load = useCallback(
    () =>
      getBusinessDay()
        .then((data) => {
          setStatus(data);
          setError("");

          if (wantsStaleClose.current) {
            wantsStaleClose.current = false;
            setParams(
              (all) => {
                const next = new URLSearchParams(all);
                next.delete("closeStale");
                return next;
              },
              { replace: true }
            );

            if (data && data.stale && data.current && canManage) {
              setStaleClose(true);
              setDialog("close");
            }
          }
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [canManage, setParams]
  );

  // Today's takings, so whoever closes knows roughly what the day took. The
  // figures are the server's, shown as they come.
  const loadSummary = useCallback(
    () =>
      canSeeSales
        ? getDaySummary()
            .then(setSummary)
            .catch(() => setSummary(null))
        : Promise.resolve(),
    [canSeeSales]
  );

  // The drawer's expected cash, for someone who may see it (not a blind
  // counter) and may close the day.
  const loadHold = useCallback(
    () =>
      canManage
        ? getClosePreview()
            .then((preview) => setDrawerHold(preview && !preview.blind && preview.figures ? preview.figures.inDrawer : null))
            .catch(() => setDrawerHold(null))
        : Promise.resolve(),
    [canManage]
  );

  useEffect(() => {
    load();
    loadSummary();
    loadHold();
    getSettings()
      .then(setSettings)
      .catch(() => undefined);
  }, [load, loadSummary, loadHold]);


  const clearStart = useCallback(() => setStartAction(null), []);

  if (loading) {
    return <Loading />;
  }

  const current = status ? status.current : null;
  const history = status ? status.history : [];
  const opening = status ? status.opening : { dates: [], taken: [], suggested: null, today: "", cutoffHour: 5 };
  const allowed = opening.dates;

  // The till's latest day may be opened again, with a reason, while it is
  // still its date (or last night's, before the morning cut-off).
  const latest = history[0] || null;
  const reopenable =
    canClose && !current && latest && latest.dayStatus === "closed" && allowed.includes(latest.businessDate) ? latest : null;

  const startReopen = (day) => {
    setForm({ businessDate: "", cash: "", notes: "", reason: "" });
    setFormError("");
    setDialog({ reopen: day });
  };

  const openDialog = () => {
    setOpenDate(opening.suggested || "");
    setJustClosed(null);
    setDialog("open");
  };

  const opened = (day, { reopened } = {}) => {
    setSuccess(`Business day ${dateText(day.businessDate, { weekday: true })} ${reopened ? "is open again" : "opened"}`);
    setDialog(null);
    setJustClosed(null);
    load();
    loadSummary();
    loadHold();
  };

  const submitReopen = async (event) => {
    event.preventDefault();
    setFormError("");

    if (!form.reason.trim()) {
      setFormError("Say why the day is being opened again.");
      shakeForm();
      return;
    }

    setSaving(true);

    try {
      const day = await reopenBusinessDay(dialog.reopen.id, form.reason.trim());
      setSuccess(`Business day ${dateText(day.businessDate, { weekday: true })} is open again`);
      setJustClosed(null);
      setDialog(null);
      load();
      loadSummary();
    } catch (err) {
      setFormError(getErrorMessage(err));
      shakeForm();
    } finally {
      setSaving(false);
    }
  };

  const closed = (day) => {
    setDialog(null);
    setSuccess("");
    setJustClosed(day);
    forgetBusinessDay();
    setDrawerHold(null);
    const thenOpen = staleClose;
    setStaleClose(false);
    load().then(() => {
      // "Close <old date> and open today": today's day straight after.
      if (thenOpen) {
        getBusinessDay()
          .then((fresh) => {
            if (fresh && !fresh.current && fresh.opening && fresh.opening.suggested) {
              setOpenDate(fresh.opening.suggested);
              setDialog("open");
            }
          })
          .catch(() => undefined);
      }
    });
    loadSummary();
  };

  const printX = async () => {
    setError("");

    try {
      const report = await getXReport({});
      printXReport(report, { restaurantName: user.restaurantName, printedBy: user.name, settings });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const quick = (type) => {
    setStartAction(type);
    setTab("drawers");
  };

  const cashRow = summary && summary.byMethod.find((row) => row.paymentMethod === "cash");
  const blind = Boolean(status && status.blind);
  const showTakings = Boolean(current && summary && summary.dayOpen && summary.businessDayId === current.id);

  const tabs = [
    { key: "day", label: "Today", icon: "sun" },
    { key: "past", label: "Past days", icon: "history" },
    // Cash drawers switched off: the tab is the day's one till, cash in and out.
    { key: "drawers", label: hasFeature("cash_drawers") ? "Drawers & cash" : "Cash in & out", icon: "wallet" },
    { key: "rules", label: "Cash rules", icon: "sliders" },
  ];
  const active = tabs.some((item) => item.key === tab) ? tab : "day";

  return (
    <div className="stack bd-page">
      <PageHeader
        icon="sun"
        title="Business day"
        description="Open the day before the first order and close it after the last bill. Sales count to the day, not the clock, so a table billed after midnight stays on the night it ate."
        action={
          canManage &&
          (current ? (
            <button type="button" className="button" onClick={() => setDialog("close")}>
              <Icon name="moon" size={16} /> Close day
            </button>
          ) : (
            <button type="button" className="button" onClick={openDialog} disabled={!opening.suggested}>
              <Icon name="sun" size={16} /> Open day
            </button>
          ))
        }
      />

      {status && status.stale && (
        <StaleDayNotice
          status={status}
          onCloseDay={() => {
            setStaleClose(true);
            setTab("day");
            setDialog("close");
          }}
        />
      )}

      <MoneyTabs label="Business day sections" active={active} onChange={setTab} tabs={tabs} />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {active === "day" && (
        <>
          {justClosed && (
            <section className="card cash-closed" aria-live="polite">
              <SuccessCheck size={48} tone="primary" label="Day closed" />
              <div className="cash-closed-text">
                <h2>Day closed</h2>
                <p className="muted small">
                  {dateText(justClosed.businessDate, { weekday: true })} is closed and its cash counted.
                </p>
                <dl className="cash-closed-facts">
                  <div>
                    <dt className="sr-only">Counted</dt>
                    <dd>
                      Counted <strong>{moneyExact(justClosed.countedCash ?? justClosed.closingCash, currency)}</strong>
                    </dd>
                  </div>
                  {justClosed.expectedCash !== null && justClosed.expectedCash !== undefined && (
                    <div>
                      <dt className="sr-only">Should have held</dt>
                      <dd>
                        Should have held <strong>{moneyExact(justClosed.expectedCash, currency)}</strong>
                      </dd>
                    </div>
                  )}
                  {justClosed.variance !== null && justClosed.variance !== undefined && (
                    <div>
                      <dt className="sr-only">Difference</dt>
                      <dd>
                        <span className={`cash-variance ${varianceClass(justClosed.variance)}`}>
                          {varianceWords(justClosed.variance, (value) => moneyExact(value, currency))}
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
              <div className="cash-closed-actions">
                {canSeeReports && (
                  <Link
                    className="button button-secondary"
                    to={`/reports?tab=dayEnd&from=${justClosed.businessDate}&to=${justClosed.businessDate}`}
                  >
                    <Icon name="file" size={16} /> Day-end sheet
                  </Link>
                )}
                {reopenable && reopenable.id === justClosed.id && (
                  <button type="button" className="link-button" onClick={() => startReopen(reopenable)}>
                    Closed by mistake? Reopen
                  </button>
                )}
              </div>
            </section>
          )}

          {current ? (
            <section className="card bd-hero is-open" aria-label="The day that is open">
              <div className="bd-hero-main">
                <span className="bd-hero-icon" aria-hidden="true">
                  <Icon name="sun" size={26} />
                </span>
                <div className="bd-hero-text">
                  <span className="bd-hero-status">
                    <Status tone={status.stale ? "danger" : "active"}>{status.stale ? "Still open from an old date" : "Open"}</Status>
                    <span className={status.stale ? "small bd-hero-old" : "muted small"}>for {openFor(current.openedAt)}</span>
                  </span>
                  <span className="bd-hero-counter">
                    <Icon name="store" size={14} /> {(status.counter && status.counter.name) || "Main counter"}
                  </span>
                  <h2 className="bd-hero-date">{dateText(current.businessDate, { weekday: true })}</h2>
                  <p className="muted bd-hero-meta">
                    Opened {momentText(current.openedAt)}
                    {current.openedByName ? ` by ${current.openedByName}` : ""}
                  </p>
                  {/* The opener's note stays on the day; the closer adds their
                      own beside it. Handover notes during the day
                      go in the shift log book. */}
                  {(current.openingNotes || current.notes) && (
                    <p className="bd-hero-notes pre-line">
                      <span className="muted small">Opening note{current.openedByName ? ` · ${current.openedByName}` : ""}: </span>
                      {current.openingNotes || current.notes}
                    </p>
                  )}
                </div>
              </div>
              <dl className="bd-hero-facts">
                <div>
                  <dt>Opening cash</dt>
                  <dd>{money(current.openingCash, currency)}</dd>
                </div>
                {!blind && drawerHold !== null && (
                  <div>
                    <dt>Drawer should hold</dt>
                    <dd>{money(drawerHold, currency)}</dd>
                  </div>
                )}
              </dl>
            </section>
          ) : (
            !justClosed && (
              <section className="card bd-hero is-closed" aria-label="No day is open">
                <div className="bd-hero-main">
                  <span className="bd-hero-icon" aria-hidden="true">
                    <Icon name="moon" size={26} />
                  </span>
                  <div className="bd-hero-text">
                    <span className="bd-hero-status">
                      <Status tone="inactive">Closed</Status>
                    </span>
                    <h2 className="bd-hero-date">No business day is open</h2>
                    <p className="muted bd-hero-meta">
                      {opening.suggested
                        ? "Open one at the start of service so orders and payments are recorded against it. The till takes no orders until a day is open."
                        : `Today's day (${dateText(opening.today)}) was already closed.${
                            reopenable ? " If it was closed by mistake, reopen it." : ""
                          }`}
                    </p>
                  </div>
                </div>
                {canManage && opening.suggested && (
                  <button type="button" className="button button-lg" onClick={openDialog}>
                    <Icon name="sun" size={18} /> Open day
                  </button>
                )}
                {!opening.suggested && reopenable && (
                  <button type="button" className="button button-secondary button-lg" onClick={() => startReopen(reopenable)}>
                    <Icon name="undo" size={18} /> Reopen {dateText(reopenable.businessDate)}
                  </button>
                )}
              </section>
            )
          )}

          {current && canManage && (
            <div className="bd-quick" role="group" aria-label="Quick actions">
              <button type="button" className="button button-secondary" onClick={() => quick("drop")}>
                <Icon name="download" size={16} /> Cash drop
              </button>
              <button type="button" className="button button-secondary" onClick={() => quick("petty_cash")}>
                <Icon name="wallet" size={16} /> Petty cash
              </button>
              <button type="button" className="button button-secondary" onClick={() => quick("paid_in")}>
                <Icon name="upload" size={16} /> Float top-up
              </button>
              <button type="button" className="button button-secondary" onClick={printX}>
                <Icon name="print" size={16} /> Print X report
              </button>
              {hasPermission("expenses.manage") && (
                <Link className="button button-secondary" to="/expenses">
                  <Icon name="receipt" size={16} /> Record expense
                </Link>
              )}
            </div>
          )}

          {showTakings && (
            <SectionCard
              icon="wallet"
              tone="success"
              title="Takings so far"
              description="Money taken on this business day, as the bills record it. The close dialog adds up what the drawer should hold."
              actions={
                <Link className="button button-secondary button-sm" to="/bills">
                  <Icon name="receipt" size={15} /> Bills
                </Link>
              }
            >
              <div className="stat-grid">
                <StatTile
                  icon="receipt"
                  tone="primary"
                  size="sm"
                  label="Sales"
                  value={money(summary.salesTotal, currency)}
                  note={`${summary.billCount} bill${summary.billCount === 1 ? "" : "s"}`}
                />
                {/* With blind counting the cash taken is not shown to the
                    person who counts it (nor the total it is part of). */}
                {!blind && (
                  <StatTile
                    icon="wallet"
                    tone="success"
                    size="sm"
                    label="Collected"
                    value={money(summary.collected, currency)}
                    note="Cash, card and UPI together"
                  />
                )}
                {blind ? (
                  <StatTile icon="eye-off" tone="neutral" size="sm" label="Taken in cash" value="Blind count" note="Counted at close" />
                ) : (
                  <StatTile
                    icon="cash"
                    tone="info"
                    size="sm"
                    label="Taken in cash"
                    value={money(cashRow ? cashRow.amount : 0, currency)}
                    note={
                      summary.cashRefunded > 0
                        ? `${money(summary.cashRefunded, currency)} paid back in cash`
                        : "Cash payments on this day"
                    }
                  />
                )}
                <StatTile
                  icon="clock"
                  tone="warning"
                  size="sm"
                  label="Still to collect"
                  value={money(summary.dueNow, currency)}
                  note="Bills not yet paid"
                  to="/bills?status=unpaid,partial"
                />
              </div>
            </SectionCard>
          )}

        </>
      )}

      {active === "past" && (
        <PastDays
          anchor={opening.today || undefined}
          currency={currency}
          reopenable={reopenable}
          onReopen={startReopen}
          canSeeReports={canSeeReports}
        />
      )}

      {active === "drawers" && (
        <DrawersPanel
          currency={currency}
          settings={settings}
          user={user}
          canManage={canManage}
          canClose={canClose}
          canSeeSales={canSeeSales}
          canSeeExpenses={hasPermission("expenses.view")}
          onChanged={() => {
            load();
            loadHold();
          }}
          startAction={startAction}
          onStarted={clearStart}
        />
      )}

      {active === "rules" && status && (
        <CashRules
          rules={status.rules}
          currency={currency}
          canEdit={canSetRules}
          onSaved={(rules) => {
            setStatus((all) => ({ ...all, rules }));
            load();
          }}
        />
      )}

      {dialog === "open" && (
        <OpenDayDialog
          opening={opening}
          currency={currency}
          initialDate={openDate}
          onClose={() => setDialog(null)}
          onOpened={opened}
        />
      )}

      {dialog === "close" && current && (
        <CloseDayDialog
          day={current}
          currency={currency}
          carryByDefault={staleClose}
          onClose={() => {
            setDialog(null);
            setStaleClose(false);
          }}
          onClosed={closed}
          onShowDrawers={() => {
            setDialog(null);
            setTab("drawers");
          }}
        />
      )}

      {dialog && dialog.reopen && (
        <Modal
          title={`Reopen ${dateText(dialog.reopen.businessDate, { weekday: true })}`}
          icon="undo"
          description="For a day closed by mistake. Its count is cleared and counted again at the next close; the close and this reopening stay in its notes and the activity log."
          onClose={() => setDialog(null)}
          width={480}
        >
          <form className="form-grid" onSubmit={submitReopen} noValidate ref={formRef}>
            <label className="field field-wide">
              <span>Why is it being reopened?</span>
              <textarea
                rows={2}
                maxLength={300}
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
                placeholder="Closed at lunch instead of the end of the shift"
                autoFocus
              />
            </label>
            <ErrorMessage message={formError} />
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Reopening…" : "Reopen the day"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
