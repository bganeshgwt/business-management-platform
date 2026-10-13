import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "../../../../components/Modal";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import LiveValue from "../../../../components/LiveValue";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  cancelCashMovement,
  closeDrawer,
  getXReport,
  listDrawers,
  recordCashMovement,
  startDrawer,
} from "../services/businessDay.service";
import { listExpenseCategories } from "../../expenses/services/expense.service";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { moneyExact } from "../../../../services/format";
import useShake from "../../../../hooks/useShake";
import CashCount from "./CashCount";
import { METHOD_WORDS, difference, notesPayload, varianceTone, varianceWords } from "./cashMath";
import { Status } from "./moneyUi";
import { momentText } from "./moneyText";
import { printXReport } from "./xReport";

// The three kinds of cash that go in or out of a drawer during the day.
const KINDS = {
  drop: {
    label: "Cash drop",
    icon: "download",
    tone: "is-drop",
    hint: "Surplus cash taken to the safe mid-shift",
    reason: "Drop to the safe at the evening rush",
  },
  petty_cash: {
    label: "Petty cash",
    icon: "wallet",
    tone: "is-petty",
    hint: "Paid out for the restaurant: ice, an auto, a quick repair",
    reason: "Ice for the bar",
  },
  paid_in: {
    label: "Float top-up",
    icon: "upload",
    tone: "is-in",
    hint: "Change brought to the drawer from the safe",
    reason: "₹10 and ₹20 notes for change",
  },
};

const ACTION = "take cash in or out of the drawer";

// Cash drawers per shift, cash in and out, and each person's takings, for the
// business day this till is trading. A morning and an evening cashier at one
// counter hand over between two drawers; two tills each keep their own. The
// day's own count at close stays the restaurant's final word on its cash.
// startAction: "drop" | "petty_cash" | "paid_in" opens that entry as the panel
// arrives (the quick actions on the Today tab); onStarted clears it.
export default function DrawersPanel({
  currency,
  settings,
  user,
  canManage,
  canClose,
  canSeeSales,
  canSeeExpenses,
  onChanged,
  startAction = null,
  onStarted = null,
}) {
  const money = (value) => moneyExact(value, currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [categories, setCategories] = useState([]);

  // { kind: "start" } | { kind: "end", drawer } | { kind: "move", type } | { kind: "cancel", movement }
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});
  const [notes, setNotes] = useState({});
  const [formError, setFormError] = useState("");
  const [refusal, setRefusal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [countRef, shakeCount] = useShake();
  const [fieldRef, shakeField] = useShake();

  // A quick action from the Today tab: its entry opens once the drawers are in.
  // (The quick actions live on another tab, so the panel mounts with it.)
  const startRef = useRef(startAction);

  const load = useCallback(
    () =>
      listDrawers()
        .then((result) => {
          setData(result);
          setError("");

          const type = startRef.current;

          if (type && KINDS[type] && result && result.day) {
            const all = result.drawers || [];
            const mine = all.find((row) => Number(row.id) === Number(result.myDrawerId));
            const openOnes = all.filter((row) => row.status === "open");
            const drawerId = mine ? mine.id : openOnes.length === 1 ? openOnes[0].id : "";

            startRef.current = null;
            setForm({ type, drawerId: drawerId ? String(drawerId) : "" });
            setNotes({});
            setFormError("");
            setRefusal(null);
            setSuccess("");
            setDialog({ kind: "move", type });

            if (onStarted) {
              onStarted();
            }
          }
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [onStarted]
  );

  useEffect(() => {
    load();

    // The headings petty cash can go under; without expenses.view it goes
    // under "Petty cash".
    if (canSeeExpenses) {
      listExpenseCategories()
        .then((rows) => setCategories(rows.filter((row) => row.status === "active")))
        .catch(() => setCategories([]));
    }
  }, [load, canSeeExpenses]);

  const changed = (message) => {
    setDialog(null);
    setSuccess(message);
    load();

    if (onChanged) {
      onChanged();
    }
  };

  const open = (next, initial = {}) => {
    setForm(initial);
    setNotes({});
    setFormError("");
    setRefusal(null);
    setSuccess("");
    setDialog(next);
  };

  const field = (key) => (event) => setForm((all) => ({ ...all, [key]: event.target.value }));

  const printX = async (query) => {
    setError("");

    try {
      const report = await getXReport(query);
      printXReport(report, { restaurantName: user.restaurantName, printedBy: user.name, settings });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  if (loading) {
    return <Loading label="Loading the drawers…" />;
  }

  if (!data || !data.day) {
    return (
      <>
        <ErrorMessage message={error} />
        <SectionCard icon="wallet" title="Drawers & cash">
          <EmptyState
            icon="moon"
            message="No business day is open."
            hint="Open the day first. Each cashier then starts a shift with the float counted into their drawer."
          />
        </SectionCard>
      </>
    );
  }

  const drawers = data.drawers;
  // Cash drawers switched off (Settings -> Features): the day is one till,
  // and this panel is only its cash in and out.
  const drawersOn = !data.drawersOff;
  const openDrawers = drawers.filter((row) => row.status === "open");
  const myDrawer = drawers.find((row) => Number(row.id) === Number(data.myDrawerId)) || null;

  // ------------------------------------------------------------ actions

  const submitStart = async (event) => {
    event.preventDefault();
    setFormError("");

    if (form.openingFloat === undefined || form.openingFloat === "" || Number(form.openingFloat) < 0) {
      setFormError("Count the float into the drawer and enter it (0 if it starts empty).");
      shakeField();
      return;
    }

    setSaving(true);

    try {
      const drawer = await startDrawer({
        openingFloat: Math.round(Number(form.openingFloat) * 100) / 100,
        label: (form.label || "").trim() || null,
        notes: (form.notes || "").trim() || null,
      });
      changed(`${drawer.cashierName}'s shift has started with ${money(drawer.openingFloat)}`);
    } catch (err) {
      setFormError(getErrorMessage(err));
      shakeField();
    } finally {
      setSaving(false);
    }
  };

  const endDrawer = dialog && dialog.kind === "end" ? dialog.drawer : null;
  const counted = form.cash === undefined || form.cash === "" ? null : Math.round(Number(form.cash) * 100) / 100;
  const endExpected = endDrawer && endDrawer.figures ? endDrawer.figures.expectedCash : null;
  const endVariance =
    endDrawer && counted !== null && endExpected !== null
      ? difference(counted, endExpected)
      : refusal && refusal.counted === counted && refusal.variance !== undefined
        ? Number(refusal.variance)
        : null;
  const endTone = endVariance === null ? null : varianceTone(endVariance, data.rules.varianceThreshold);

  const submitEnd = async (event) => {
    event.preventDefault();
    setFormError("");

    if (counted === null || counted < 0) {
      setFormError("Enter the cash counted in the drawer. An empty box is not ₹0: type 0 only if the drawer is really empty.");
      shakeCount();
      return;
    }

    if (endTone === "far" && !(form.reason || "").trim()) {
      setFormError(
        `The drawer is ${varianceWords(endVariance, money)}. More than ${money(data.rules.varianceThreshold)} needs a reason.`
      );
      shakeField();
      return;
    }

    setSaving(true);

    try {
      const closed = await closeDrawer(endDrawer.id, {
        closingCash: counted,
        countMethod: form.method || "notes",
        denominations: (form.method || "notes") === "notes" ? notesPayload(notes, data.rules.denominations) : null,
        varianceReason: (form.reason || "").trim() || null,
        notes: (form.notes || "").trim() || null,
      });
      changed(
        `${closed.cashierName}'s shift has ended: ${money(closed.countedCash)} counted${
          closed.variance !== null ? `, ${varianceWords(closed.variance, money).toLowerCase()}` : ""
        }`
      );
    } catch (err) {
      const details = err.response && err.response.data && err.response.data.data;
      setFormError(getErrorMessage(err));

      if (details && details.reason === "variance_reason_required") {
        setRefusal({ ...details, counted });
        shakeField();
      } else {
        shakeCount();
      }
    } finally {
      setSaving(false);
    }
  };

  const moveType = dialog && dialog.kind === "move" ? form.type || dialog.type : null;

  const submitMove = async (event) => {
    event.preventDefault();
    setFormError("");

    const amount = Math.round(Number(form.amount) * 100) / 100;

    if (!(amount > 0)) {
      setFormError("Enter the amount of cash.");
      shakeField();
      return;
    }

    if (!(form.reason || "").trim()) {
      setFormError("Say what the cash was for.");
      shakeField();
      return;
    }

    const kind = KINDS[moveType];
    const payload = {
      type: moveType,
      amount,
      reason: form.reason.trim(),
      drawerId: form.drawerId ? Number(form.drawerId) : null,
      expenseCategoryId: moveType === "petty_cash" && form.categoryId ? Number(form.categoryId) : null,
    };

    setSaving(true);

    try {
      const movement = await withApproval((headers) => recordCashMovement(payload, headers), `${kind.label} of ${money(amount)}`, {
        permission: "cash.movements",
        action: ACTION,
        scope: { businessDayId: data.day.id, amount, cashMove: moveType },
      });
      changed(`${movement.typeLabel} of ${money(movement.amount)} recorded`);
    } catch (err) {
      setFormError(getErrorMessage(err));
      shakeField();
    } finally {
      setSaving(false);
    }
  };

  const submitCancel = async (event) => {
    event.preventDefault();
    setFormError("");

    const movement = dialog.movement;

    if (!(form.reason || "").trim()) {
      setFormError("Say why this entry is cancelled.");
      shakeField();
      return;
    }

    setSaving(true);

    try {
      await withApproval(
        (headers) => cancelCashMovement(movement.id, form.reason.trim(), headers),
        `Cancel ${movement.typeLabel.toLowerCase()} of ${money(movement.amount)}`,
        { permission: "cash.movements", action: ACTION, scope: { businessDayId: movement.businessDayId, amount: movement.amount, cashMove: `cancel_${movement.type}` } }
      );
      changed(`${movement.typeLabel} of ${money(movement.amount)} cancelled`);
    } catch (err) {
      setFormError(getErrorMessage(err));
      shakeField();
    } finally {
      setSaving(false);
    }
  };

  // The drawer an entry goes into by default: your own, else the only one open.
  const defaultDrawer = myDrawer ? myDrawer.id : openDrawers.length === 1 ? openDrawers[0].id : "";

  // ------------------------------------------------------------ the screen

  const blind = data.blind;
  const people = data.byCashier || [];
  // A drawer counted at the end of its shift was signed against its entries:
  // they can no longer be cancelled (the server refuses it too).
  const countedDrawers = new Set(drawers.filter((drawer) => drawer.status === "closed").map((drawer) => drawer.id));
  const ORDER = Object.keys(METHOD_WORDS);
  const methodsSeen = [...new Set(people.flatMap((person) => person.methods.map((row) => row.method)))].sort(
    (x, y) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99)
  );

  const moveColumns = [
    {
      key: "when",
      header: "When",
      type: "datetime",
      value: (move) => move.createdAt,
      mobile: "subtitle",
      render: (move) => <span className="nowrap small">{momentText(move.createdAt)}</span>,
    },
    {
      key: "what",
      header: "What",
      value: (move) => move.typeLabel,
      mobile: "title",
      pin: true,
      filter: "select",
      render: (move) => {
        const kind = KINDS[move.type] || { icon: "wallet", tone: "" };

        return (
          <span className="bd-when">
            <span className={`cash-move-kind ${kind.tone}`}>
              <Icon name={kind.icon} size={14} /> {move.typeLabel}
            </span>
            {move.status === "cancelled" && <Status tone="inactive">Cancelled</Status>}
          </span>
        );
      },
    },
    {
      key: "amount",
      header: "Amount",
      type: "money",
      exact: true,
      // In or out of the drawer: a float top-up adds, the rest take away.
      value: (move) => (move.type === "paid_in" ? 1 : -1) * Number(move.amount),
      mobile: "show",
      render: (move) => (
        <strong className="cash-move-amount">
          {move.type === "paid_in" ? "+" : "−"}
          {money(move.amount)}
        </strong>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      value: (move) => move.reason,
      mobile: "show",
      width: 260,
      render: (move) => (
        <span className="bd-when">
          <span>{move.reason}</span>
          {move.categoryName && <span className="small muted">Expense: {move.categoryName}</span>}
          {move.status === "cancelled" && move.cancelReason && (
            <span className="small muted">
              Cancelled by {move.cancelledByName || "a manager"}: {move.cancelReason}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "drawer",
      header: "Drawer",
      value: (move) => (move.drawerCashierName ? `${move.drawerCashierName}'s` : "The day's drawer"),
      mobile: "show",
      render: (move) => <span className="small">{move.drawerCashierName ? `${move.drawerCashierName}'s` : "The day's drawer"}</span>,
    },
    {
      key: "by",
      header: "By",
      value: (move) => move.createdByName || "",
      mobile: "hide",
      render: (move) => (
        <span className="bd-when small">
          <span>{move.createdByName || "—"}</span>
          {move.approvedByName && <span className="muted">PIN: {move.approvedByName}</span>}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (move) =>
              move.status === "cancelled" ? null : move.drawerId && countedDrawers.has(move.drawerId) ? (
                <span className="muted small" title="This drawer was counted at the end of its shift, so its entries can no longer change. Record a correction on an open drawer.">
                  <Icon name="lock" size={12} /> Counted
                </span>
              ) : (
                <button type="button" className="link-button" onClick={() => open({ kind: "cancel", movement: move })}>
                  Cancel
                </button>
              ),
          },
        ]
      : []),
  ];

  const peopleColumns = [
    {
      key: "person",
      header: "Person",
      value: (person) => person.name,
      mobile: "title",
      pin: true,
      render: (person) => <strong>{person.name}</strong>,
    },
    ...methodsSeen.map((method) => ({
      key: `m-${method}`,
      header: METHOD_WORDS[method] || method,
      type: "money",
      exact: true,
      total: "sum",
      value: (person) => {
        const found = person.methods.find((row) => row.method === method);
        return found ? Number(found.amount) : null;
      },
      render: (person) => {
        const found = person.methods.find((row) => row.method === method);
        return found ? money(found.amount) : <span className="muted">—</span>;
      },
    })),
    {
      key: "total",
      header: "Total",
      type: "money",
      exact: true,
      total: "sum",
      value: (person) => Number(person.total),
      render: (person) => (
        <strong>
          <LiveValue value={person.total} align="end">
            {money(person.total)}
          </LiveValue>
        </strong>
      ),
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (person) => (
        <button type="button" className="link-button" onClick={() => printX({ cashierId: person.userId })}>
          X report
        </button>
      ),
    },
  ];

  return (
    <div className="stack">
      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <div className="stat-grid">
        {drawersOn && (
        <StatTile
          icon="users"
          tone={openDrawers.length > 0 ? "success" : "neutral"}
          size="sm"
          label="Shifts open"
          value={String(openDrawers.length)}
          of={` of ${drawers.length}`}
          note={openDrawers.length > 0 ? "Each is counted when its shift ends" : "No cashier has a drawer open"}
        />
        )}
        <StatTile
          icon="download"
          tone="info"
          size="sm"
          label="Dropped to the safe"
          value={money(data.totals.dropped)}
          note="Taken out of drawers today"
        />
        <StatTile
          icon="wallet"
          tone="warning"
          size="sm"
          label="Petty cash paid"
          value={money(data.totals.pettyCash)}
          note="Also an approved expense of the day"
        />
        <StatTile
          icon="upload"
          tone="success"
          size="sm"
          label="Float top-ups"
          value={money(data.totals.paidIn)}
          note="Change brought from the safe"
        />
      </div>

      {drawersOn && (
      <SectionCard
        icon="users"
        title="Shifts"
        description="Each cashier's drawer: the float it started with, what they took, and their count when the shift ends."
        actions={
          canManage &&
          !myDrawer && (
            <button
              type="button"
              className="button button-sm"
              onClick={() => open({ kind: "start" }, { openingFloat: data.suggestedFloat === null ? "" : String(data.suggestedFloat) })}
            >
              <Icon name="plus" size={15} /> Start my shift
            </button>
          )
        }
        flush
      >
        {drawers.length === 0 ? (
          <EmptyState
            icon="users"
            message="No shifts started today."
            hint="With one cashier all day the day's own count is enough. With two tills or a change of cashier, each starts a shift here, so each drawer is counted on its own."
          />
        ) : (
          <div className="drawer-grid">
            {drawers.map((drawer) => {
              const f = drawer.figures || {};
              const mine = Number(drawer.id) === Number(data.myDrawerId);
              const isOpen = drawer.status === "open";

              return (
                <article
                  key={drawer.id}
                  className={`drawer-card ${isOpen ? "is-open" : ""} ${mine ? "is-mine" : ""}`}
                  data-motion-item
                >
                  <div className="drawer-card-head">
                    <span className="drawer-card-who">
                      <strong>
                        {drawer.cashierName}
                        {mine ? " (you)" : ""}
                      </strong>
                      <span className="small muted">
                        {drawer.label ? `${drawer.label} · ` : ""}
                        {momentText(drawer.openedAt)}
                        {drawer.closedAt ? ` – ${momentText(drawer.closedAt).split(", ")[1]}` : ""}
                      </span>
                    </span>
                    {isOpen ? <Status tone="active">Open</Status> : <Status tone="neutral">Counted</Status>}
                  </div>

                  <dl className="drawer-figures">
                    <div>
                      <dt>Float</dt>
                      <dd>{money(f.openingFloat)}</dd>
                    </div>
                    {f.cashTaken !== null && f.cashTaken !== undefined && (
                      <div>
                        <dt>+ Cash taken</dt>
                        <dd>
                          <LiveValue value={f.cashTaken} align="end">
                            {money(f.cashTaken)}
                          </LiveValue>
                        </dd>
                      </div>
                    )}
                    {f.cashRefunded > 0 && (
                      <div>
                        <dt>− Cash refunds</dt>
                        <dd>{money(f.cashRefunded)}</dd>
                      </div>
                    )}
                    {f.pettyCash > 0 && (
                      <div>
                        <dt>− Petty cash</dt>
                        <dd>{money(f.pettyCash)}</dd>
                      </div>
                    )}
                    {f.supplierCash > 0 && (
                      <div>
                        <dt>− Paid to suppliers</dt>
                        <dd>{money(f.supplierCash)}</dd>
                      </div>
                    )}
                    {f.otherExpenses > 0 && (
                      <div>
                        <dt>− Other cash expenses</dt>
                        <dd>{money(f.otherExpenses)}</dd>
                      </div>
                    )}
                    {f.dropped > 0 && (
                      <div>
                        <dt>− Dropped to the safe</dt>
                        <dd>{money(f.dropped)}</dd>
                      </div>
                    )}
                    {f.paidIn > 0 && (
                      <div>
                        <dt>+ Float top-ups</dt>
                        <dd>{money(f.paidIn)}</dd>
                      </div>
                    )}
                    {isOpen ? (
                      <div className="is-total">
                        <dt>Should hold now</dt>
                        <dd>
                          {f.expectedCash === null || f.expectedCash === undefined ? (
                            <span className="drawer-blind">
                              <Icon name="eye-off" size={14} /> Blind count
                            </span>
                          ) : (
                            <LiveValue value={f.expectedCash} align="end">
                              {money(f.expectedCash)}
                            </LiveValue>
                          )}
                        </dd>
                      </div>
                    ) : (
                      <>
                        <div className="is-total">
                          <dt>Counted</dt>
                          <dd>{money(drawer.countedCash)}</dd>
                        </div>
                        {drawer.expectedAtClose !== null && (
                          <div>
                            <dt>Should have held</dt>
                            <dd>{money(drawer.expectedAtClose)}</dd>
                          </div>
                        )}
                        {drawer.variance !== null && (
                          <div>
                            <dt>Difference</dt>
                            <dd>
                              <span
                                className={`cash-variance ${
                                  Math.abs(drawer.variance) < 0.005 ? "is-match" : drawer.variance < 0 ? "is-short" : "is-over"
                                }`}
                              >
                                {varianceWords(drawer.variance, money)}
                              </span>
                            </dd>
                          </div>
                        )}
                      </>
                    )}
                  </dl>

                  {drawer.varianceReason && <p className="small muted">Reason: {drawer.varianceReason}</p>}

                  <div className="drawer-card-actions">
                    {canSeeSales && (
                      <button type="button" className="button button-secondary button-sm" onClick={() => printX({ drawerId: drawer.id })}>
                        <Icon name="print" size={15} /> {isOpen ? "X report" : "Shift report"}
                      </button>
                    )}
                    {isOpen && (mine || canClose) && canManage && (
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => open({ kind: "end", drawer }, { method: "notes", cash: "" })}
                      >
                        <Icon name="lock" size={15} /> End shift
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
      )}

      <SectionCard
        icon="wallet"
        title="Cash in and out"
        description="Cash taken to the safe, petty cash paid out, and change brought in. A cashier records one with a manager's PIN; a mistake is cancelled with a reason, never deleted."
        actions={
          canManage && (
            <div className="cash-move-actions">
              {Object.entries(KINDS).map(([type, kind]) => (
                <button
                  type="button"
                  key={type}
                  className="button button-secondary button-sm"
                  onClick={() => open({ kind: "move", type }, { type, drawerId: defaultDrawer ? String(defaultDrawer) : "" })}
                >
                  <Icon name={kind.icon} size={15} /> {kind.label}
                </button>
              ))}
            </div>
          )
        }
        flush
      >
        <DataGrid
          id="cash-movements"
          caption="Cash in and out of the drawers today"
          columns={moveColumns}
          rows={data.movements}
          rowKey={(move) => move.id}
          empty="No cash in or out today."
          emptyIcon="wallet"
          emptyHint="A cash drop to the safe, ₹200 for ice, or change brought from the safe: record it here so the drawer still adds up at close."
          rowClassName={(move) => (move.status === "cancelled" ? "dg-tone-muted is-cancelled" : "")}
          exportName="cash-movements"
          currency={currency}
        />
      </SectionCard>

      {canSeeSales && people.length > 0 && (
        <SectionCard
          icon="user"
          title="Takings by person"
          description="What each person took today, whatever drawer it went into. Print one person's X report for a quick mid-shift check."
          flush
        >
          <DataGrid
            id="takings-by-person"
            caption="Takings by person today"
            variant="compact"
            pageSize={false}
            columns={peopleColumns}
            rows={people}
            rowKey={(person) => person.userId}
            currency={currency}
          />
        </SectionCard>
      )}

      {dialog && dialog.kind === "start" && (
        <Modal
          title="Start my shift"
          icon="users"
          description="Count the float into the drawer. Everything you take until you end the shift counts to this drawer."
          onClose={() => setDialog(null)}
          width={480}
        >
          <form className="form-grid" onSubmit={submitStart} noValidate>
            <label className="field field-wide" ref={fieldRef}>
              <span>Float counted into the drawer ({currency})</span>
              <span className="bd-cash">
                <span className="bd-cash-symbol" aria-hidden="true">
                  {currency}
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={form.openingFloat ?? ""}
                  onChange={field("openingFloat")}
                  autoFocus
                />
              </span>
              <small className="muted">
                {data.suggestedFloat !== null
                  ? `Filled with ${drawers.length === 0 ? "the day's opening cash" : "what the last shift counted"}; change it to what you counted.`
                  : "Count it yourself before you start."}
              </small>
            </label>
            <label className="field">
              <span>Till or counter</span>
              <input value={form.label || ""} onChange={field("label")} maxLength={60} placeholder="Counter 2" />
            </label>
            <label className="field">
              <span>Notes</span>
              <input value={form.notes || ""} onChange={field("notes")} maxLength={500} placeholder="Optional" />
            </label>
            <ErrorMessage message={formError} />
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Starting…" : "Start shift"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {endDrawer && (
        <Modal
          title={`End ${endDrawer.cashierName}'s shift`}
          icon="lock"
          description="Count the drawer. The count is kept with what it should have held; more than the allowed difference needs a reason."
          onClose={() => setDialog(null)}
          width={600}
        >
          <form className="form-grid" onSubmit={submitEnd} noValidate>
            <CashCount
              countRef={countRef}
              currency={currency}
              value={form.cash ?? ""}
              onChange={(value) => setForm((all) => ({ ...all, cash: value }))}
              method={form.method || "notes"}
              onMethod={(method) => setForm((all) => ({ ...all, method }))}
              notes={notes}
              onNotes={setNotes}
              denominations={data.rules.denominations}
              refused={Boolean(formError) && counted === null}
              message={counted === null ? formError : ""}
              autoFocus
            />

            {endExpected !== null ? (
              <div className="field-wide cash-diff-row">
                <dl className="cash-expect is-single">
                  <div className="is-total">
                    <dt>Should hold</dt>
                    <dd>{money(endExpected)}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              blind && (
                <div className="field-wide alert alert-info">
                  Blind count: what the drawer should hold is not shown. The difference is said once the count is in.
                </div>
              )
            )}

            {endVariance !== null && (
              <div className={`field-wide cash-diff is-${endTone}`} aria-live="polite">
                <span className="cash-diff-label">
                  <Icon name={endTone === "match" ? "check-circle" : "alert-circle"} size={18} />
                  {endTone === "match" ? "The count matches" : endVariance < 0 ? "Short" : "Over"}
                </span>
                <span className="cash-diff-value">
                  <LiveValue value={endVariance} align="end">
                    {money(Math.abs(endVariance))}
                  </LiveValue>
                </span>
              </div>
            )}

            {endTone === "far" && (
              <label className="field field-wide" ref={fieldRef}>
                <span>Why is the drawer {endVariance < 0 ? "short" : "over"}?</span>
                <textarea rows={2} maxLength={300} value={form.reason || ""} onChange={field("reason")} />
              </label>
            )}

            <label className="field field-wide">
              <span>Notes for the next shift</span>
              <input value={form.notes || ""} onChange={field("notes")} maxLength={500} placeholder="Optional" />
            </label>

            <ErrorMessage message={formError} />
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Ending…" : "End shift"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog && dialog.kind === "move" && (
        <Modal
          title="Cash in or out"
          icon="wallet"
          description="Record it as it happens, so the drawer still adds up at close. Needs a manager or a manager's PIN."
          onClose={() => setDialog(null)}
          width={600}
        >
          <form className="form-grid" onSubmit={submitMove} noValidate>
            <div className="field-wide cash-kinds" role="radiogroup" aria-label="Kind of cash entry">
              {Object.entries(KINDS).map(([type, kind]) => (
                <button
                  type="button"
                  key={type}
                  role="radio"
                  aria-checked={moveType === type}
                  className={`cash-kind ${moveType === type ? "is-active" : ""}`}
                  onClick={() => setForm((all) => ({ ...all, type }))}
                >
                  <strong>
                    <Icon name={kind.icon} size={15} /> {kind.label}
                  </strong>
                  <span>{kind.hint}</span>
                </button>
              ))}
            </div>

            <label className="field" ref={fieldRef}>
              <span>Amount ({currency})</span>
              <span className="bd-cash">
                <span className="bd-cash-symbol" aria-hidden="true">
                  {currency}
                </span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  value={form.amount || ""}
                  onChange={field("amount")}
                  autoFocus
                />
              </span>
            </label>

            {drawersOn && (
            <label className="field">
              <span>Drawer</span>
              <select value={form.drawerId || ""} onChange={field("drawerId")}>
                <option value="">The day's drawer (no shift)</option>
                {openDrawers.map((drawer) => (
                  <option key={drawer.id} value={drawer.id}>
                    {drawer.cashierName}&apos;s drawer{drawer.label ? ` · ${drawer.label}` : ""}
                  </option>
                ))}
              </select>
            </label>
            )}

            <label className="field field-wide">
              <span>What it was for</span>
              <input
                value={form.reason || ""}
                onChange={field("reason")}
                maxLength={300}
                placeholder={KINDS[moveType] ? KINDS[moveType].reason : ""}
              />
            </label>

            {moveType === "petty_cash" && canSeeExpenses && (
              <label className="field field-wide">
                <span>Expense category</span>
                <select value={form.categoryId || ""} onChange={field("categoryId")}>
                  <option value="">Petty cash</option>
                  {categories
                    .filter((category) => category.name.toLowerCase() !== "petty cash")
                    .map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                </select>
                <small className="muted">Petty cash is also written as an approved cash expense of today, under this heading.</small>
              </label>
            )}

            <ErrorMessage message={formError} />
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Recording…" : `Record ${KINDS[moveType] ? KINDS[moveType].label.toLowerCase() : "entry"}`}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog && dialog.kind === "cancel" && (
        <Modal
          title={`Cancel ${dialog.movement.typeLabel.toLowerCase()}`}
          icon="x-circle"
          description={`${money(dialog.movement.amount)} · ${dialog.movement.reason}. It stays on record as cancelled and stops counting in the drawer${
            dialog.movement.type === "petty_cash" ? "; its expense is rejected" : ""
          }.`}
          onClose={() => setDialog(null)}
          width={480}
        >
          <form className="form-grid" onSubmit={submitCancel} noValidate>
            <label className="field field-wide" ref={fieldRef}>
              <span>Why is it cancelled?</span>
              <input
                value={form.reason || ""}
                onChange={field("reason")}
                maxLength={300}
                placeholder="Typed ₹1,000 instead of ₹100"
                autoFocus
              />
            </label>
            <ErrorMessage message={formError} />
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setDialog(null)}>
                Keep it
              </button>
              <button type="submit" className="button button-danger" disabled={saving}>
                {saving ? "Cancelling…" : "Cancel the entry"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
