import { useCallback, useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import GuestAvatar from "./GuestAvatar";
import { adjustCustomerPoints, getCustomerHistory, revealGuestContact } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { count, money } from "@bmp/shared/format";
import { orderTypeLabel } from "../../../../services/labels";
import { dateTime, shortDate, tagLabel } from "../../../../services/guestBook";
import "../styles/crm.css";
import GuestOccasion from "./GuestOccasion";
import GuestAddresses from "./GuestAddresses";

const ENTRY_LABELS = {
  earn: "Earned",
  redeem: "Redeemed",
  adjust: "Adjusted",
  expire: "Cancelled",
};

// A visit list is mostly this year, and repeating "2026" down twenty-three
// rows is noise: dateTime writes the year only when it is not this one.
const formatDate = dateTime;
const visitDate = dateTime;

// One guest at a glance: how much they have spent, what they keep ordering and
// every movement of their points.
//
// One row per visit. An order paid on two bills (a split) used to show twice,
// with the same React key, and the Visits tab counted rows while the tile
// counted visits. Now the server sends one row per order with every bill on
// it, cancelled orders are marked and not counted, and the tab uses the same
// number as the tile.
export default function CustomerHistoryModal({ customer, currency = "₹", canManage, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("visits");
  const [moreLoading, setMoreLoading] = useState(false);

  const [adjusting, setAdjusting] = useState(false);
  const [points, setPoints] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // A cashier who sees this guest's number masked can open it on purpose
  // (to call them back); it is on the activity log and limited per day.
  const [contact, setContact] = useState(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(
    () =>
      getCustomerHistory(customer.id)
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [customer.id]
  );

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    setMoreLoading(true);

    try {
      const next = await getCustomerHistory(customer.id, { visitsOffset: data.orders.length });
      setData({ ...data, orders: [...data.orders, ...next.orders.filter((o) => !data.orders.some((x) => x.id === o.id))] });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setMoreLoading(false);
    }
  };

  // Points by hand are loyalty.adjust. Without it, a manager standing at the
  // till approves this guest, this many points and which way they go with
  // their PIN: an approval to add 20 cannot be used to take 20 away.
  const submitAdjustment = async (event) => {
    event.preventDefault();
    setSaving(true);

    const amount = Math.round(Number(points));

    try {
      await withApproval(
        (headers) => adjustCustomerPoints(customer.id, { points: amount, notes }, headers),
        `${amount > 0 ? "Give" : "Take away"} ${Math.abs(amount)} points ${amount > 0 ? "to" : "from"} ${customer.name}`,
        {
          permission: "loyalty.adjust",
          scope: amount > 0 ? { customerId: customer.id, points: amount } : { customerId: customer.id, pointsOff: -amount },
        }
      );
      setAdjusting(false);
      setPoints("");
      setNotes("");
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      if (!err.approvalCancelled) {
        setError(getErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const openContact = async () => {
    setOpening(true);

    try {
      setContact(await revealGuestContact(customer.id));
      setError("");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOpening(false);
    }
  };

  const guest = data ? data.customer : customer;
  const erased = Boolean(guest.erased);
  const shown = contact
    ? { mobile: contact.mobileDisplay, email: contact.email, address: contact.address }
    : { mobile: guest.mobileDisplay, email: guest.email || guest.emailMasked, address: guest.address };
  const visitRows = data ? data.orders : [];
  const moreVisits = data ? data.ordersTotal > visitRows.length : false;

  return (
    <Modal
      title={guest.name}
      icon="user"
      description="Every visit, what they usually order, and every movement of their points."
      onClose={onClose}
      width={900}
    >
      <div className="stack crm-history">
        <ErrorMessage message={error} />

        {loading || !data ? (
          <Loading />
        ) : (
          <>
            <div className="crm-history-head">
              <GuestAvatar guest={guest} size="lg" />
              <div className="crm-history-who">
                {/* "Anniversary today", "Birthday Sat". */}
                <GuestOccasion guest={guest} />
                {guest.tags.length > 0 && (
                  <div className="crm-history-tags">
                    {guest.tags.map((value) => (
                      <span key={value} className={`crm-tag crm-tag-${value}`}>
                        {tagLabel(value)}
                      </span>
                    ))}
                  </div>
                )}
                <p className="small crm-history-contact">
                  {[
                    shown.mobile,
                    shown.email,
                    guest.dateOfBirth ? `Birthday ${shortDate(`${guest.dateOfBirth}T00:00:00`).replace(/ \d{4}$/, "")}` : null,
                    guest.anniversaryDate
                      ? `Anniversary ${shortDate(`${guest.anniversaryDate}T00:00:00`).replace(/ \d{4}$/, "")}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || <span className="muted">No contact details</span>}
                  {guest.contactHidden && !contact && canManage && !erased && (guest.mobileDisplay || guest.emailMasked) && (
                    <button type="button" className="link-button crm-reveal" onClick={openContact} disabled={opening}>
                      <Icon name="eye" size={14} />
                      {opening ? "Opening…" : "Show full number"}
                    </button>
                  )}
                </p>
                {shown.address && <p className="small muted">{shown.address}</p>}
                {contact && contact.logged && (
                  <p className="small muted">Opened just now. Opening a guest's number is on the activity log.</p>
                )}
                {guest.companyName && (
                  <p className="small muted">
                    {guest.companyName}
                    {guest.gstin ? ` · GSTIN ${guest.gstin}${guest.gstState ? ` (${guest.gstState})` : ""}` : ""}
                  </p>
                )}
                {(guest.panMasked || guest.panDeclaration) && (
                  <p className="small muted">
                    {guest.panMasked ? `PAN ${guest.pan || guest.panMasked}` : "Declared they have no PAN (Form 97)"}
                  </p>
                )}
                <p className="small muted">
                  {guest.marketingOptIn
                    ? `Agreed to receive offers${guest.marketingOptInAt ? ` on ${shortDate(guest.marketingOptInAt)}` : ""}`
                    : "Has not agreed to receive offers"}
                  {guest.contactHidden && !contact ? " · contact details partly hidden for your role" : ""}
                </p>
              </div>
            </div>

            {erased && (
              <p className="alert alert-notice">
                This guest's personal details were erased at their request on {shortDate(guest.erasedAt)}. Their bills
                and visits are kept for the accounts.
              </p>
            )}

            {guest.allergies && (
              <p className="alert crm-allergy-banner" role="note">
                <strong>Allergic to:</strong> {guest.allergies}
              </p>
            )}

            <div className="stat-grid crm-history-stats">
              <StatTile
                size="sm"
                icon="calendar"
                tone="info"
                label="Visits"
                value={count(data.summary.visits)}
                note={
                  data.summary.cancelled
                    ? `${count(data.summary.cancelled)} cancelled order${data.summary.cancelled === 1 ? "" : "s"} not counted`
                    : data.summary.firstVisit
                      ? `Since ${shortDate(data.summary.firstVisit)}`
                      : "No visits yet"
                }
              />
              <StatTile
                size="sm"
                icon="money"
                tone="primary"
                label="Total spent"
                value={money(data.summary.totalSpent, currency)}
                note="Bills on their visits, void bills left out"
              />
              <StatTile
                size="sm"
                icon="receipt"
                tone="neutral"
                label="Per visit"
                // Whole rupees, as Guest insights and the sales report show an
                // average; the exact figure is on hover.
                value={money(Math.round(Number(data.summary.averageSpend || 0)), currency)}
                title={`${money(data.summary.averageSpend, currency)} exactly`}
                note={`Last visit ${data.summary.lastVisit ? shortDate(data.summary.lastVisit) : "—"}`}
              />
              <StatTile
                size="sm"
                icon="gift"
                tone="violet"
                label="Points"
                value={count(guest.loyaltyPoints)}
                note="Balance today"
              />
            </div>

            {data.favourites.length > 0 && (
              <div className="crm-favourites">
                <span className="crm-favourites-label">
                  <Icon name="utensils" size={14} /> Usually orders
                </span>
                {data.favourites.map((item, index) => (
                  <span key={`${item.itemName}-${index}`} className="crm-fav">
                    {item.itemName}
                    <span className="muted"> ×{item.quantity}</span>
                  </span>
                ))}
              </div>
            )}

            {data.merges.length > 0 && (
              <p className="muted small crm-merge-note">
                <Icon name="users" size={14} />
                <span>
                  {data.merges
                    .map(
                      (merge) =>
                        `Merged from ${merge.mergedName || "another record"}${merge.mergedMobile ? ` (${merge.mergedMobile})` : ""} on ${shortDate(merge.mergedAt)}${merge.mergedBy ? ` by ${merge.mergedBy}` : ""}`
                    )
                    .join(" · ")}
                </span>
              </p>
            )}

            <GuestAddresses customerId={customer.id} canManage={canManage} />

            <div className="tab-row crm-history-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "visits"}
                className={`tab ${tab === "visits" ? "active" : ""}`}
                onClick={() => setTab("visits")}
              >
                <Icon name="receipt" size={15} />
                Visits
                {data.summary.visits > 0 && <span className="muted small"> · {count(data.summary.visits)}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "points"}
                className={`tab ${tab === "points" ? "active" : ""}`}
                onClick={() => setTab("points")}
              >
                <Icon name="gift" size={15} />
                Points
              </button>
            </div>

            {tab === "visits" ? (
              <>
                <DataGrid
                  id="crm-guest-visits"
                  variant="compact"
                  caption={`Visits by ${guest.name}`}
                  columns={[
                    {
                      key: "order",
                      header: "Order",
                      value: (order) => order.orderNumber,
                      mobile: "title",
                      render: (order) => (
                        <span className="nowrap">
                          <span className="mono">{order.orderNumber}</span>
                          {order.cancelled && <div className="badge badge-neutral">Cancelled · not a visit</div>}
                        </span>
                      ),
                    },
                    {
                      key: "when",
                      header: "When",
                      type: "datetime",
                      value: (order) => order.placedAt,
                      mobile: "subtitle",
                      render: (order) => <span className="small nowrap">{visitDate(order.placedAt)}</span>,
                    },
                    {
                      key: "type",
                      header: "Type",
                      value: (order) => orderTypeLabel(order.orderType),
                      render: (order) => <span className="small">{orderTypeLabel(order.orderType)}</span>,
                    },
                    {
                      key: "items",
                      header: "Items",
                      value: (order) => order.items,
                      mobile: "show",
                      render: (order) => <span className="small">{order.items || "—"}</span>,
                    },
                    {
                      key: "bill",
                      header: "Bill",
                      value: (order) => order.billNumbers.join(", "),
                      mobile: "show",
                      render: (order) => (
                        <span className="small">
                          {order.billNumbers.length === 0
                            ? "—"
                            : order.billNumbers.map((number) => (
                                <div key={number} className="mono nowrap">
                                  {number}
                                </div>
                              ))}
                          {order.billCount > 1 && <div className="muted">split into {order.billCount} bills</div>}
                        </span>
                      ),
                    },
                    {
                      key: "amount",
                      header: "Amount",
                      type: "money",
                      value: (order) => (order.billTotal === null ? (order.cancelled ? null : order.orderTotal) : order.billTotal),
                      mobile: "show",
                      render: (order) => (
                        <span className="nowrap crm-strong">
                          {order.cancelled && order.billTotal === null ? (
                            <span className="muted small">Not charged</span>
                          ) : order.billTotal === null ? (
                            <>
                              {money(order.orderTotal, currency)}
                              <div className="muted small nowrap">not billed yet</div>
                            </>
                          ) : (
                            money(order.billTotal, currency)
                          )}
                        </span>
                      ),
                    },
                  ]}
                  rows={visitRows}
                  rowKey={(order) => order.id}
                  rowClassName={(order) => (order.cancelled ? "dg-tone-muted crm-cancelled-row" : "")}
                  currency={currency}
                  rowNoun={["visit", "visits"]}
                  empty="This guest has not ordered yet."
                  emptyIcon="receipt"
                  emptyHint="Their visits appear here once the guest is attached to an order at the till."
                />
                {moreVisits && (
                  <div className="form-actions crm-more">
                    <span className="muted small">
                      Showing {count(visitRows.length)} of {count(data.ordersTotal)} orders
                    </span>
                    <button type="button" className="button button-secondary button-sm" onClick={loadMore} disabled={moreLoading}>
                      <Icon name="history" size={15} />
                      {moreLoading ? "Loading…" : "Show older visits"}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="stack">
                {canManage && !erased && (
                  <div className="crm-points-bar">
                    <span className="muted small">Points earned on bills are added by themselves. Give or take points by hand here.</span>
                    <button type="button" className="button button-secondary button-sm" onClick={() => setAdjusting(!adjusting)}>
                      <Icon name={adjusting ? "x" : "sliders"} size={15} />
                      {adjusting ? "Cancel adjustment" : "Adjust points"}
                    </button>
                  </div>
                )}

                {adjusting && (
                  <form className="form-grid crm-adjust" onSubmit={submitAdjustment}>
                    <label className="field">
                      <span>Points *</span>
                      <input
                        type="number"
                        value={points}
                        onChange={(event) => setPoints(event.target.value)}
                        required
                        placeholder="50 to add, -50 to take away"
                      />
                    </label>
                    <label className="field">
                      <span>Reason *</span>
                      <input
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        required
                        maxLength={200}
                        placeholder="Goodwill for a late order"
                      />
                    </label>
                    <p className="muted small field-wide">
                      Points by hand need a manager: without that permission, a manager approves with their PIN. Every
                      adjustment is on the activity log.
                    </p>
                    <div className="form-actions field-wide">
                      <button type="submit" className="button" disabled={saving}>
                        <Icon name="check" size={16} />
                        {saving ? "Saving…" : "Apply"}
                      </button>
                    </div>
                  </form>
                )}

                <DataGrid
                  id="crm-guest-points"
                  variant="compact"
                  caption={`Points history for ${guest.name}`}
                  columns={[
                    {
                      key: "when",
                      header: "When",
                      type: "datetime",
                      value: (entry) => entry.createdAt,
                      mobile: "subtitle",
                      render: (entry) => <span className="small">{formatDate(entry.createdAt)}</span>,
                    },
                    {
                      key: "what",
                      header: "What",
                      value: (entry) => ENTRY_LABELS[entry.entryType] || entry.entryType,
                      mobile: "title",
                    },
                    {
                      key: "bill",
                      header: "Bill",
                      value: (entry) => entry.billNumber,
                      render: (entry) => <span className="mono small">{entry.billNumber || "—"}</span>,
                    },
                    {
                      key: "note",
                      header: "Note",
                      value: (entry) => entry.notes,
                      mobile: "show",
                      minWidth: 180,
                      render: (entry) => (
                        <span className="small">
                          {entry.notes || "—"}
                          {entry.createdByName && <div className="muted">by {entry.createdByName}</div>}
                        </span>
                      ),
                    },
                    {
                      key: "points",
                      header: "Points",
                      type: "number",
                      value: (entry) => entry.points,
                      mobile: "show",
                      render: (entry) => (
                        <span className={`crm-strong ${entry.points > 0 ? "crm-plus" : entry.points < 0 ? "crm-minus" : ""}`}>
                          {entry.points > 0 ? `+${entry.points}` : entry.points}
                        </span>
                      ),
                    },
                    {
                      key: "balance",
                      header: "Balance",
                      type: "number",
                      value: (entry) => entry.balanceAfter,
                      mobile: "show",
                      render: (entry) => <span className="mono">{entry.balanceAfter}</span>,
                    },
                  ]}
                  rows={data.loyalty}
                  rowKey={(entry) => entry.id}
                  rowNoun={["entry", "entries"]}
                  empty="No points have moved yet."
                  emptyIcon="gift"
                  emptyHint="Points are earned on paid bills when loyalty is switched on in Settings."
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
