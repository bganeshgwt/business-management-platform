import { useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "../../../../services/format";
import { joinOrderTable, moveOrderDishes, moveOrderTable } from "../services/order.service";
import { lineMoney, round2 } from "../services/orderCart";
import { heldSentence } from "../../../../services/floorTables";
import TableGrid from "./TableGrid";

// Guests moving on the floor, from the POS:
//   table   the whole party to a free table
//   join    a table pushed against this one; guests already eating there
//           join this order (their dishes and KOTs come along)
//   dishes  chosen dishes (all or some of a line) to another table
//
// Nothing here changes a price or sends the kitchen anything again: the
// server moves the lines and their KOTs as they are.
const TITLES = {
  table: (order) => `Move ${order.orderNumber} to another table`,
  join: (order) => `Join a table to ${order.tableNo}`,
  dishes: (order) => `Move dishes from ${order.tableNo}`,
};

const HELP = {
  table: (order) =>
    `Pick a free table. The order, its KOTs and its bill go with the party, and ${order.tableNo} is free again.`,
  join: () =>
    "Pick the table being pushed against this one. If guests are already eating there, their order joins this one, dishes and KOTs and all, and the party gets one bill.",
  dishes: () =>
    "Choose what moves and how many. It goes onto the order at the table you pick, or onto a new order if that table is free. The kitchen is not sent anything twice.",
};

const ICONS = { table: "switch", join: "link", dishes: "arrow-right" };

const dishLabel = (line) => `${line.itemName}${line.variantName ? ` (${line.variantName})` : ""}`;

export default function MoveDialog({ mode, order, tables, joinedBy, now, currency, taxMode, onClose, onDone }) {
  const lines = order.items.filter((item) => item.itemStatus !== "cancelled");
  const [step, setStep] = useState(mode === "dishes" ? "dishes" : "table");
  const [picked, setPicked] = useState(() => new Map());
  const [guests, setGuests] = useState("");
  const [target, setTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const own = new Set([order.tableId, ...(order.joinedTables || []).map((table) => table.tableId)]);
  const chosen = lines.filter((line) => (picked.get(line.id) || 0) > 0);
  const movingValue = round2(
    chosen.reduce((sum, line) => {
      const quantity = picked.get(line.id);

      return sum + (quantity === line.quantity ? line.lineTotal : lineMoney({ ...line, quantity, taxMode }).total);
    }, 0)
  );
  const everything = lines.length > 0 && lines.every((line) => picked.get(line.id) === line.quantity);
  // Plates, the way the waiter counts them: two naan are two dishes, not one.
  const plates = round2(chosen.reduce((sum, line) => sum + picked.get(line.id), 0));
  const platesText = `${plates} ${plates === 1 ? "dish" : "dishes"}`;

  const setQuantity = (line, quantity) =>
    setPicked((current) => {
      const next = new Map(current);
      next.set(line.id, Math.max(0, Math.min(line.quantity, round2(quantity))));
      return next;
    });

  const reasonOff = (table, info) => {
    if (own.has(table.id)) {
      return table.id === order.tableId ? "This party's table" : "Already part of this order";
    }

    if (info.state === "off") {
      return "Out of service";
    }

    if (mode === "table" && ["running", "printed", "paid", "joined"].includes(info.state)) {
      return info.state === "joined" ? `Part of ${info.orderNumber}` : "Guests are eating here";
    }

    if (mode !== "table" && info.state === "joined") {
      return `Part of ${info.orderNumber}`;
    }

    if (mode !== "table" && (info.state === "printed" || info.state === "paid")) {
      return "Bill already printed";
    }

    return null;
  };

  const send = async (table, overrideHold) => {
    setBusy(true);
    setError("");

    try {
      const payload = { tableId: table.id, overrideHold: Boolean(overrideHold) };
      let result;

      if (mode === "table") {
        result = await moveOrderTable(order.id, payload);
      } else if (mode === "join") {
        result = await joinOrderTable(order.id, payload);
      } else {
        result = await moveOrderDishes(order.id, {
          ...payload,
          guests: guests ? Number(guests) : undefined,
          items: chosen.map((line) => ({ id: line.id, quantity: picked.get(line.id), seenQuantity: line.quantity })),
        });
      }

      onDone(result.data, result.message);
    } catch (err) {
      const details = err.response?.data?.data || {};

      if (details.reason === "table_held") {
        setConfirm({ table, held: true, message: getErrorMessage(err) });
      } else {
        setError(getErrorMessage(err));
        setConfirm(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = (table, info) => {
    setTarget(table);
    setError("");

    if (info.state === "held") {
      setConfirm({
        table,
        held: true,
        message: `Table ${table.tableNo} is ${heldSentence(info.booking)}. ${
          mode === "dishes" ? "Put these dishes" : "Seat the party"
        } there anyway?`,
      });
      return;
    }

    if (mode === "join" && info.orderNumber) {
      setConfirm({
        table,
        message: `Guests are eating on ${table.tableNo} (${info.orderNumber}). Join their order into ${order.orderNumber}? Their dishes and KOTs move onto this order, and ${table.tableNo} stays with this party until the bill is paid.`,
      });
      return;
    }

    if (mode === "dishes") {
      setConfirm({
        table,
        message: `Move ${chosen.map((line) => `${picked.get(line.id)} × ${dishLabel(line)}`).join(", ")} to ${table.tableNo}${
          info.orderNumber ? `, onto ${info.orderNumber}` : ", on a new order"
        }?`,
      });
      return;
    }

    send(table, false);
  };

  return (
    <Modal title={TITLES[mode](order)} icon={ICONS[mode]} description={HELP[mode](order)} onClose={onClose} width={820}>
      <div className="stack pos-move">
        {mode === "dishes" && (
          <ol className="pos-move-steps" aria-label="Steps">
            <li className={step === "dishes" ? "is-current" : "is-done"}>
              <span className="pos-move-step-no">{step === "dishes" ? "1" : <Icon name="check" size={13} />}</span>
              What moves
            </li>
            <li className={step === "table" ? "is-current" : ""}>
              <span className="pos-move-step-no">2</span>
              Where to
            </li>
          </ol>
        )}
        <ErrorMessage message={error} />

        {step === "dishes" && (
          <>
            <ul className="pos-move-lines">
              {lines.map((line) => {
                const quantity = picked.get(line.id) || 0;

                return (
                  <li key={line.id} className={quantity > 0 ? "is-picked" : ""}>
                    <div className="pos-move-dish">
                      <strong>{dishLabel(line)}</strong>
                      <span className="muted small">
                        {line.quantity} on the order · {moneyExact(line.unitPrice + line.modifierTotal, currency)} each
                        {line.kitchenQuantity > 0 ? " · the kitchen has it" : ""}
                      </span>
                    </div>
                    <div className="qty-controls">
                      <button type="button" onClick={() => setQuantity(line, quantity - 1)} disabled={quantity <= 0} aria-label={`One less ${line.itemName} to move`}>
                        <Icon name="minus" size={16} />
                      </button>
                      <span>{quantity}</span>
                      <button type="button" onClick={() => setQuantity(line, quantity + 1)} disabled={quantity >= line.quantity} aria-label={`One more ${line.itemName} to move`}>
                        <Icon name="plus" size={16} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="button button-secondary button-sm pos-move-all"
                      onClick={() => setQuantity(line, quantity === line.quantity ? 0 : line.quantity)}
                    >
                      {quantity === line.quantity ? "None" : "All"}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="pos-move-foot">
              <label className="field pos-move-guests">
                <span>Guests moving (optional)</span>
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={guests}
                  onChange={(event) => setGuests(event.target.value)}
                />
              </label>
              <p className={`pos-move-summary ${chosen.length > 0 ? "has-picked" : ""}`}>
                {chosen.length === 0
                  ? "Nothing chosen yet."
                  : everything
                    ? "Every dish is moving: the whole party moves, and this table is free again."
                    : `${platesText} · ${moneyExact(movingValue, currency)} moving`}
              </p>
            </div>

            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="button" disabled={chosen.length === 0} onClick={() => setStep("table")}>
                Choose the table
                <Icon name="arrow-right" size={16} />
              </button>
            </div>
          </>
        )}

        {step === "table" && (
          <>
            {mode === "dishes" && (
              <button type="button" className="button button-ghost button-sm pos-move-back" onClick={() => setStep("dishes")}>
                <Icon name="chevron-left" size={16} />
                Change the dishes ({platesText} chosen)
              </button>
            )}
            <TableGrid
              tables={tables}
              joinedBy={joinedBy}
              now={now}
              currency={currency}
              choose={choose}
              reasonOff={reasonOff}
              selectedId={target ? target.id : null}
            />
          </>
        )}

        {confirm && (
          <div className={`pos-move-confirm ${confirm.held ? "is-held" : ""}`} role="alertdialog" aria-label="Confirm the move">
            <p>
              <Icon name={confirm.held ? "calendar" : "help"} size={18} />
              <span>{confirm.message}</span>
            </p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setConfirm(null)} disabled={busy}>
                {confirm.held ? "Choose another table" : "Back"}
              </button>
              <button type="button" className="button" onClick={() => send(confirm.table, confirm.held)} disabled={busy}>
                {busy ? "Moving…" : confirm.held ? "Yes, use it anyway" : "Yes, move"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
