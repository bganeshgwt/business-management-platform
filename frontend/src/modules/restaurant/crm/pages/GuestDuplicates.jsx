import { useCallback, useEffect, useState } from "react";
import Icon from "../../../../components/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import MergeGuestsModal from "./MergeGuestsModal";
import GuestAvatar from "./GuestAvatar";
import { listDuplicates, markNotDuplicate } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "../../../../services/format";
import { shortDate } from "../../../../services/guestBook";

// One side of a pair: who, the number as it is on file, and what they hold.
function DuplicateSide({ label, guest, number, currency }) {
  return (
    <div className="crm-dup-side">
      <span className="crm-dup-label">{label}</span>
      <span className="crm-dup-who">
        <GuestAvatar guest={guest} />
        <span className="crm-dup-who-text">
          <strong>{guest.name}</strong>
          <span className="muted small mono">{number}</span>
        </span>
      </span>
      <span className="crm-dup-facts small">
        <span>
          <strong>{count(guest.visits)}</strong> visits
        </span>
        <span>
          <strong>{money(guest.spend, currency)}</strong>
        </span>
        <span>
          <strong>{count(guest.loyaltyPoints)}</strong> pts
        </span>
      </span>
      <span className="muted small">Last visit {guest.lastVisit ? shortDate(guest.lastVisit) : "never"}</span>
    </div>
  );
}

// The pairs the mobile clean-up found: two records that turned out to hold
// the same number once it was written one way, or the same ten digits once as
// an Indian mobile and once with "+" in front (read as a number from abroad).
// Most are one guest saved twice (points split, visits split); some are a
// family sharing a phone. A manager decides which, one pair at a time.
export default function GuestDuplicates({ canMerge, currency, onChanged }) {
  const [pairs, setPairs] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [merging, setMerging] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(
    () =>
      listDuplicates()
        .then((rows) => {
          setPairs(rows);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const dismiss = async (pair) => {
    setBusy(pair.duplicate.id);

    try {
      await markNotDuplicate(pair.duplicate.id);
      setNotice(`${pair.duplicate.name} is kept as a separate guest`);
      await load();
      onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!pairs) {
    return error ? <ErrorMessage message={error} /> : <Loading />;
  }

  return (
    <div className="stack">
      <ErrorMessage message={error} />
      {notice && (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      )}

      <p className="alert alert-info crm-lead">
        Every mobile is now saved one way (9876543210, +91 98765 43210 and 098765-43210 are the same number), so a
        guest can no longer be added twice by mobile. These records were already on file twice, some with a “+” typed
        in front of an Indian number. Merge them to bring their visits and points together, or keep them apart if
        they are two people sharing a phone.
      </p>

      {pairs.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="check-circle"
            message="No possible duplicates."
            hint="Two records of one guest under different mobiles or names can still be merged from the guest's ⋯ menu."
          />
        </div>
      ) : (
        <ul className="crm-dup-list">
          {pairs.map((pair) => (
            <li key={pair.duplicate.id} className="card crm-dup-card">
              <div className="crm-dup-sides">
                <DuplicateSide
                  label="On file with the number"
                  guest={pair.keep}
                  number={pair.keep.mobileDisplay || "—"}
                  currency={currency}
                />
                <span className="crm-dup-equals" aria-hidden="true">
                  =?
                </span>
                <DuplicateSide
                  label="Saved again as"
                  guest={pair.duplicate}
                  number={pair.duplicate.typedMobile ? `typed “${pair.duplicate.typedMobile}”` : "—"}
                  currency={currency}
                />
              </div>

              {canMerge ? (
                <div className="crm-dup-actions">
                  <button
                    type="button"
                    className="button button-sm"
                    onClick={() =>
                      setMerging({
                        first: { ...pair.keep },
                        second: { ...pair.duplicate, mobileDisplay: null },
                      })
                    }
                  >
                    <Icon name="users" size={15} /> Merge…
                  </button>
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    disabled={busy === pair.duplicate.id}
                    onClick={() => dismiss(pair)}
                  >
                    <Icon name="x" size={15} /> Not the same person
                  </button>
                </div>
              ) : (
                <p className="muted small">A manager can merge these.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {merging && (
        <MergeGuestsModal
          first={merging.first}
          second={merging.second}
          currency={currency}
          onClose={() => setMerging(null)}
          onMerged={(message) => {
            setMerging(null);
            setNotice(message);
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
