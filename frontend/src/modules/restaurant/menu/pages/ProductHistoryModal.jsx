import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getProductHistory } from "../services/menu.service";
import { getErrorMessage } from "../../../../services/api";
import { dayMonth } from "../../../../services/dates";
import { describeDetails } from "../../reports/pages/activityWords";
import "../../../../styles/menu.css";

// "Who changed the price of Paneer Tikka, and when?" answered on the dish
// itself: every edit, price change, sold-out switch and size change from the
// activity log, newest first, with the value before and after.

const sizeName = (label) => {
  const at = String(label || "").lastIndexOf(" · ");
  return at >= 0 ? label.slice(at + 3) : label;
};

// "Menu import (prices.csv)" -> "menu import (prices.csv)", file name intact.
const lowerFirst = (text) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const headline = (entry) => {
  const changes = (entry.details && entry.details.changes) || {};
  const via = entry.details && entry.details.via;

  if (entry.entityType === "product") {
    if (entry.action === "availability") {
      return changes.available && changes.available[1] ? "Put back on sale" : "Marked sold out";
    }

    if (entry.action === "create") {
      return via ? `Added by ${lowerFirst(via)}` : "Added to the menu";
    }

    if (entry.action === "delete") {
      return "Deleted";
    }

    return via ? `Changed by ${lowerFirst(via)}` : "Edited";
  }

  if (entry.entityType === "product_variant") {
    const size = sizeName(entry.entityLabel);
    return entry.action === "create" ? `Size ${size} added` : entry.action === "delete" ? `Size ${size} removed` : `Size ${size} changed`;
  }

  if (entry.entityType === "combo") {
    return entry.action === "delete" ? "No longer a combo" : "Combo parts changed";
  }

  if (entry.entityType === "product_image") {
    return entry.action === "delete" ? "Photo removed" : "New photo";
  }

  if (entry.entityType === "product_modifiers") {
    return "Add-ons changed";
  }

  return entry.action;
};

// The mark on the timeline: its colour says what kind of change it was, and
// the icon says it again for anyone who does not read the colour.
const MARK = {
  availability: { tone: "warning", icon: "ban" },
  delete: { tone: "danger", icon: "trash" },
  create: { tone: "success", icon: "plus" },
};

// Back on sale is good news, so it gets its own mark rather than the sold-out one.
const backOnSale = (entry) => {
  const changes = (entry.details && entry.details.changes) || {};
  return entry.action === "availability" && Boolean(changes.available && changes.available[1]);
};

const markFor = (entry) =>
  backOnSale(entry) ? { tone: "success", icon: "check-circle" } : MARK[entry.action] || { tone: "primary", icon: "edit" };

// "23 Sep 2026, 4:10 pm" with the app's own month names: the browser's
// en-IN short month writes September as "Sept", which no other screen does.
const when = (value) => {
  const day = dayMonth(value, { year: true });
  const time = dayMonth(value, { time: true }).split(", ").pop();

  return day ? `${day}, ${time}` : "";
};

export default function ProductHistoryModal({ product, onClose }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getProductHistory(product.id)
      .then(setHistory)
      .catch((err) => setError(getErrorMessage(err)));
  }, [product.id]);

  return (
    <Modal
      title={`${product.name} — change history`}
      description="Every change to this dish from the activity log, newest first."
      icon="history"
      onClose={onClose}
      width={720}
      footer={
        <button type="button" className="button button-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />

        {!history && !error && <Loading />}

        {history && history.items.length === 0 && (
          <EmptyState
            icon="history"
            message="No changes recorded for this dish yet"
            hint="Edits, price changes, sold-out switches and size changes will show here, with who made them."
          />
        )}

        {history && history.items.length > 0 && (
          <ol className="mnu-history">
            {history.items.map((entry) => {
              const { via: _via, ...rest } = entry.details || {};
              const lines = describeDetails(rest);
              const mark = markFor(entry);

              return (
                <li key={entry.id}>
                  <span className={`mnu-history-mark tone-${mark.tone}`} aria-hidden="true">
                    <Icon name={mark.icon} size={13} />
                  </span>
                  <div className="mnu-history-head">
                    <strong>{headline(entry)}</strong>
                    <span className="muted small nowrap">{when(entry.createdAt)}</span>
                  </div>
                  <div className="muted small">
                    by {entry.userName || "someone"}
                    {entry.approverName && `, approved by ${entry.approverName}`}
                  </div>
                  {lines.length > 0 && (
                    <ul className="mnu-history-lines">
                      {lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Modal>
  );
}
