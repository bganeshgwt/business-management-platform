import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getLeaveBalances } from "../services/staff.service";
import { getErrorMessage } from "../../../../services/api";

const dayText = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

const days = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

// Which leave a leave day is, with what the person has left of each.
//
// Marking leave on the roster or the attendance sheet opens this. Choosing a
// type with nothing left warns before anything is saved: the day would be
// unpaid. The server refuses it too until the manager says "save anyway".
//
//   onSave({ leaveTypeId, acceptOverAllowance }) -> a promise; a refusal with
//   reason "leave_over_allowance" turns into the warning here.
export default function LeaveChoice({ employee, date, onClose, onSave }) {
  const [balances, setBalances] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLeaveBalances(employee.id, date)
      .then((data) => {
        setBalances(data.types);
        const first = data.types.find((type) => type.isDefault) || data.types[0];
        setChosen(first ? first.typeId : null);
      })
      .catch((err) => {
        setBalances([]);
        setError(getErrorMessage(err));
      });
  }, [employee.id, date]);

  const type = balances ? balances.find((row) => row.typeId === chosen) : null;
  const overNow = Boolean(type && type.paid && type.left < 1);

  const save = async (accept = false) => {
    setBusy(true);
    setError("");

    try {
      await onSave({ leaveTypeId: chosen, acceptOverAllowance: accept });
    } catch (err) {
      if (err.response?.data?.data?.reason === "leave_over_allowance") {
        setWarning(err.response.data.message);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Leave — ${employee.name}`}
      description={`${dayText(date)}. Choose which leave it is.`}
      icon="calendar"
      onClose={onClose}
      width={500}
    >
      {!balances ? (
        <Loading label="Checking what they have left…" />
      ) : (
        <div className="stack">
          <ErrorMessage message={error} />
          <div className="staff-leave-options" role="radiogroup" aria-label="Leave type">
            {balances.map((row) => {
              const empty = row.paid && row.left < 1;

              return (
                <label key={row.typeId} className={`staff-choice ${chosen === row.typeId ? "is-checked" : ""}`}>
                  <input
                    type="radio"
                    name="leave-type"
                    checked={chosen === row.typeId}
                    onChange={() => {
                      setChosen(row.typeId);
                      setWarning("");
                    }}
                  />
                  <span>
                    <strong>{row.name}</strong>
                    <small className={empty ? "text-danger" : "muted"}>
                      {row.paid
                        ? `${days(Math.max(0, row.left))} of ${days(row.available)} left in ${row.periodLabel}${row.carriedIn ? ` (${days(row.carriedIn)} carried in)` : ""}`
                        : `Unpaid · ${row.taken} taken in ${row.periodLabel}`}
                    </small>
                  </span>
                  <span className={`badge ${row.paid ? (empty ? "badge-danger" : "badge-active") : "badge-neutral"}`}>
                    {row.paid ? (empty ? "None left" : "Paid") : "Unpaid"}
                  </span>
                </label>
              );
            })}
          </div>

          {(warning || overNow) && (
            <div className="alert alert-notice" role="alert">
              <Icon name="alert" size={16} />{" "}
              {warning ||
                `${employee.name} has no ${type.name} leave left for ${type.periodLabel}, so this day would be unpaid (loss of pay).`}
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            {warning ? (
              <button type="button" className="button staff-button-warning" onClick={() => save(true)} disabled={busy}>
                {busy ? "Saving…" : "Save anyway — unpaid"}
              </button>
            ) : (
              <button type="button" className="button" onClick={() => save(false)} disabled={busy || !chosen}>
                {busy ? "Saving…" : "Save leave"}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
