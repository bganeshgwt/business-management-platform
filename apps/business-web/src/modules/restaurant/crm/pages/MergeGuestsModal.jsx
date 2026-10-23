import { useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import GuestPicker from "./GuestPicker";
import GuestAvatar from "./GuestAvatar";
import { mergeGuests } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { money, count } from "@bmp/shared/format";
import { shortDate } from "../../../../services/guestBook";

// Which record stays when nobody has chosen: the one the guest actually uses
// (more visits), then the older one.
const likelierKeeper = (a, b) => {
  if ((a.visits || 0) !== (b.visits || 0)) {
    return (a.visits || 0) > (b.visits || 0) ? a : b;
  }

  return new Date(a.createdAt) <= new Date(b.createdAt) ? a : b;
};

function Side({ guest, keep, onKeep, currency }) {
  return (
    <label className={`crm-merge-side ${keep ? "is-keep" : "is-merge"}`}>
      <span className="crm-merge-choice">
        <input type="radio" name="keep" checked={keep} onChange={onKeep} />
        <span>{keep ? "Keep this record" : "Fold into the other"}</span>
      </span>
      <span className="crm-merge-who">
        <GuestAvatar guest={guest} />
        <span className="crm-merge-who-text">
          <strong className="crm-merge-name">{guest.name}</strong>
          <span className="muted small">{guest.mobileDisplay || guest.typedMobile || "No mobile"}</span>
        </span>
      </span>
      <dl className="crm-merge-facts">
        <div>
          <dt>Visits</dt>
          <dd>{count(guest.visits || 0)}</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>{money(guest.spend || 0, currency)}</dd>
        </div>
        <div>
          <dt>Points</dt>
          <dd>{count(guest.loyaltyPoints || 0)}</dd>
        </div>
        <div>
          <dt>Last visit</dt>
          <dd>{guest.lastVisit ? shortDate(guest.lastVisit) : "—"}</dd>
        </div>
      </dl>
      <span className="muted small">Added {shortDate(guest.createdAt)}</span>
    </label>
  );
}

// Two records of one guest become one. Everything on the folded record
// (orders, bills, feedback, complaints, points, bookings) moves to the kept
// one; points add up; the kept record fills its blanks from the other; the
// folded record is removed. The server does it in one step, and logs it.
export default function MergeGuestsModal({ first, second = null, currency = "₹", onClose, onMerged }) {
  const [other, setOther] = useState(second);
  const [keepId, setKeepId] = useState(() => (second ? likelierKeeper(first, second).id : first.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const choose = (guest) => {
    setOther(guest);

    if (guest) {
      setKeepId(likelierKeeper(first, guest).id);
    }
  };

  const keep = other && keepId === other.id ? other : first;
  const fold = other ? (keep === first ? other : first) : null;

  const merge = async () => {
    setSaving(true);
    setError("");

    try {
      const result = await mergeGuests(keep.id, fold.id);
      onMerged(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Merge two records of one guest"
      icon="users"
      description="Pick the record to keep. Everything on the other one moves onto it."
      onClose={onClose}
      width={760}
    >
      <div className="stack">
        <ErrorMessage message={error} />

        {!other ? (
          <div className="crm-merge-find">
            <p className="muted">
              Find the other record of this guest: the same person saved twice, under another name or without a mobile.
            </p>
            {/* The record being merged stays in view while searching, so the
                matches can be checked against it. */}
            <div className="crm-picked crm-merge-this">
              <GuestAvatar guest={first} />
              <span className="crm-picked-text">
                <strong>{first.name}</strong>
                <span className="muted small">
                  {[
                    first.mobileDisplay || "No mobile",
                    `${count(first.visits || 0)} ${first.visits === 1 ? "visit" : "visits"}`,
                    `${count(first.loyaltyPoints || 0)} points`,
                    first.lastVisit ? `last visit ${shortDate(first.lastVisit)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="badge badge-neutral">This record</span>
            </div>
            <GuestPicker
              value={null}
              onChange={choose}
              exclude={first.id}
              label="The other record"
              noMatch="Try part of the name, the mobile or the company."
              autoFocus
            />
            <p className="small muted crm-merge-next">
              <Icon name="info" size={15} />
              <span>
                Next you see both records side by side and choose which one to keep. Nothing changes until you press
                Merge.
              </span>
            </p>
          </div>
        ) : (
          <>
            <div className="crm-merge-grid">
              <Side guest={first} keep={keep === first} onKeep={() => setKeepId(first.id)} currency={currency} />
              <span className="crm-merge-arrow" aria-hidden="true">
                <Icon name={keep === first ? "arrow-left" : "arrow-right"} size={20} />
              </span>
              <Side guest={other} keep={keep === other} onKeep={() => setKeepId(other.id)} currency={currency} />
            </div>

            <div className="alert alert-notice crm-merge-summary">
              <strong>What happens</strong>
              <ul>
                <li>
                  {fold.name}'s {count(fold.visits || 0)} visits, bills, feedback, complaints and bookings move to{" "}
                  {keep.name}.
                </li>
                <li>
                  Points add up: {count(keep.loyaltyPoints || 0)} + {count(fold.loyaltyPoints || 0)} ={" "}
                  <strong>{count((keep.loyaltyPoints || 0) + (fold.loyaltyPoints || 0))}</strong>.
                </li>
                <li>{keep.name}'s details stay; anything missing (email, birthday, tags) is taken from {fold.name}.</li>
                {(keep.gstin || fold.gstin) && (
                  <li>
                    Tax invoices already issued keep the company and GSTIN they were made out to. If either record also has
                    ordinary bills, the merged record does not carry the GSTIN {keep.gstin || fold.gstin} (it is noted on
                    the record instead), so those bills stay ordinary sales.
                  </li>
                )}
                <li>{fold.name}'s record is removed. This cannot be undone; the activity log keeps who did it.</li>
              </ul>
            </div>

            <div className="form-actions">
              {!second && (
                <button type="button" className="button button-ghost crm-push-left" onClick={() => choose(null)}>
                  <Icon name="search" size={16} /> Pick another record
                </button>
              )}
              <button type="button" className="button button-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="button" onClick={merge} disabled={saving}>
                <Icon name="check" size={16} />
                {saving ? "Merging…" : `Merge into ${keep.name}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
