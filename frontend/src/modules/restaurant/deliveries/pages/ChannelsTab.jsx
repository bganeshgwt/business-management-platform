// Sales channels and their settings.

import { useCallback, useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "../../../../services/format";
import { createChannel, deleteChannel, listChannels, updateChannel } from "../services/delivery.service";
import { CHANNEL_TYPES, COLORS, TYPE_LABEL, rupees } from "./deliveryFormat";

// ---------------------------------------------------------------- channels

const EMPTY_CHANNEL = {
  name: "",
  type: "aggregator",
  commissionPercent: "",
  deliveryCharge: 0,
  deliveryFreeAbove: null,
  color: "orange",
  status: "active",
};

export default function ChannelsTab() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("restaurant.settings.manage");
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      listChannels()
        .then((rows) => {
          setChannels(rows);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (channel) => {
    try {
      const result = await updateChannel(channel.id, {
        name: channel.name,
        type: channel.type,
        commissionPercent: channel.commissionPercent,
        color: channel.color,
        status: channel.status === "active" ? "inactive" : "active",
      });
      setMessage(`${result.data.name} ${result.data.status === "active" ? "switched on" : "switched off"}`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const remove = async () => {
    setBusy(true);

    try {
      const result = await deleteChannel(deleting.id);
      setMessage(result.message);
      setDeleting(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  if (!channels && !error) {
    return <Loading label="Loading channels…" />;
  }

  return (
    <div className="stack">
      <SectionCard
        className="dlv-channels-intro"
        icon="store"
        title="Where your orders come from"
        description="Commission is what a channel keeps from each bill. The channel report takes it off the bill totals to show what you really earned. A new rate applies to orders tagged from now on; orders already taken keep the rate they were taken at."
        actions={
          canEdit && (
            <button type="button" className="button" onClick={() => setEditing(EMPTY_CHANNEL)}>
              <Icon name="plus" size={16} /> Add channel
            </button>
          )
        }
      />

      <ErrorMessage message={error} />
      {message && (
        <div className="alert alert-success" role="status">
          {message}
        </div>
      )}

      {channels && channels.length === 0 ? (
        <EmptyState icon="store" message="No channels yet" hint="Add your own delivery, Swiggy, Zomato and phone orders." />
      ) : (
        <div className="dlv-channel-grid">
          {(channels || []).map((channel) => (
            <article key={channel.id} className={`dlv-channel-card sw-${channel.color} ${channel.status !== "active" ? "is-off" : ""}`}>
              <header>
                <span className="dlv-channel-swatch" aria-hidden="true" />
                <div className="dlv-channel-name">
                  <h3>{channel.name}</h3>
                  <span className="muted small">{TYPE_LABEL[channel.type] || channel.type}</span>
                </div>
                <span className={`badge status-badge ${channel.status === "active" ? "badge-active" : "badge-inactive"}`}>
                  <span className="badge-dot" aria-hidden="true" />
                  {channel.status === "active" ? "Active" : "Switched off"}
                </span>
              </header>

              <div className="dlv-channel-rate">
                <span className="dlv-channel-rate-value">{channel.commissionPercent}%</span>
                <span className="muted small">
                  {channel.commissionPercent > 0
                    ? `commission · on ${money(1000)} they keep ${money(channel.commissionPercent * 10)}`
                    : "no commission — every rupee is yours"}
                </span>
              </div>

              {channel.deliveryCharge > 0 && (
                <p className="dlv-channel-charge">
                  <Icon name="truck" size={14} /> Delivery charge {money(channel.deliveryCharge)}
                  {channel.deliveryFreeAbove ? ` · free above ${money(channel.deliveryFreeAbove)}` : ""}
                </p>
              )}

              {/* Both counts are orders placed and not cancelled, so today
                  is always part of the 30 days. */}
              <dl className="dlv-channel-figures">
                <div>
                  <dt>Today</dt>
                  <dd>
                    {count(channel.ordersToday)} {channel.ordersToday === 1 ? "order" : "orders"}
                  </dd>
                </div>
                <div>
                  <dt>Last 30 days</dt>
                  <dd>
                    {count(channel.orders30d)} {channel.orders30d === 1 ? "order" : "orders"}
                    <span className="dlv-channel-billed">{rupees(channel.gross30d)} billed</span>
                  </dd>
                </div>
              </dl>

              {canEdit && (
                <footer>
                  <button type="button" className="chip-button" onClick={() => setEditing(channel)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <button type="button" className="chip-button" onClick={() => toggle(channel)}>
                    {channel.status === "active" ? "Switch off" : "Switch on"}
                  </button>
                  {channel.ordersTotal === 0 && (
                    <button type="button" className="chip-button dlv-danger-chip" onClick={() => setDeleting(channel)}>
                      Delete
                    </button>
                  )}
                </footer>
              )}
            </article>
          ))}
        </div>
      )}

      {!canEdit && (
        <p className="muted small">Changing channels and commission needs the restaurant settings permission.</p>
      )}

      {editing && (
        <ChannelModal
          channel={editing}
          onClose={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            setMessage(text);
            load();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="It has never been used on an order, so nothing in your history changes."
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

function ChannelModal({ channel, onClose, onDone }) {
  const [form, setForm] = useState({
    name: channel.name,
    type: channel.type,
    commissionPercent: channel.commissionPercent === "" ? "" : String(channel.commissionPercent),
    deliveryCharge: channel.deliveryCharge ? String(channel.deliveryCharge) : "",
    deliveryFreeAbove: channel.deliveryFreeAbove ? String(channel.deliveryFreeAbove) : "",
    color: channel.color,
    status: channel.status,
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const rate = Number(form.commissionPercent || 0);
  const type = CHANNEL_TYPES.find((one) => one.value === form.type);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      name: form.name,
      type: form.type,
      commissionPercent: form.commissionPercent === "" ? 0 : Number(form.commissionPercent),
      deliveryCharge: form.deliveryCharge === "" ? 0 : Number(form.deliveryCharge),
      deliveryFreeAbove: form.deliveryFreeAbove === "" ? null : Number(form.deliveryFreeAbove),
      color: form.color,
      status: form.status,
    };

    try {
      const result = channel.id ? await updateChannel(channel.id, payload) : await createChannel(payload);
      onDone(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={channel.id ? `Edit ${channel.name}` : "Add a channel"}
      description="A place orders come from, and what it keeps from each bill."
      icon="store"
      onClose={onClose}
      width={560}
    >
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />

        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            maxLength={60}
            placeholder="e.g. Magicpin, ONDC, Corporate orders"
            autoFocus
          />
        </label>

        <div className="field">
          <span>Type</span>
          <div className="segmented dlv-type-pick" role="radiogroup" aria-label="Channel type">
            {CHANNEL_TYPES.map((one) => (
              <button
                type="button"
                key={one.value}
                role="radio"
                aria-checked={form.type === one.value}
                className={`segment ${form.type === one.value ? "is-active" : ""}`}
                onClick={() => setForm({ ...form, type: one.value })}
              >
                {one.label}
              </button>
            ))}
          </div>
          <span className="muted small">{type && type.hint}</span>
        </div>

        <label className="field">
          <span>Commission %</span>
          <input
            type="number"
            min="0"
            max="50"
            step="0.5"
            inputMode="decimal"
            value={form.commissionPercent}
            onChange={(event) => setForm({ ...form, commissionPercent: event.target.value })}
            placeholder="0"
          />
          <span className="muted small">
            {rate > 0 && rate <= 50
              ? `On a ${money(1000)} bill, ${form.name || "this channel"} keeps ${money(rate * 10)} and you keep ${money(1000 - rate * 10)}.`
              : "Between 0 and 50. Leave at 0 for your own riders, phone and website."}
          </span>
        </label>

        {/* The trip charge the guest pays on this channel's deliveries
            (SW-A-17). Swiggy and Zomato collect their own, so usually 0. */}
        <div className="dlv-charge-fields">
          <label className="field">
            <span>Delivery charge</span>
            <input
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              value={form.deliveryCharge}
              onChange={(event) => setForm({ ...form, deliveryCharge: event.target.value })}
              placeholder="0"
            />
          </label>
          <label className="field">
            <span>Free above</span>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="decimal"
              value={form.deliveryFreeAbove}
              onChange={(event) => setForm({ ...form, deliveryFreeAbove: event.target.value })}
              placeholder="Always charge"
              disabled={!(Number(form.deliveryCharge) > 0)}
            />
          </label>
          <span className="muted small dlv-charge-hint">
            {Number(form.deliveryCharge) > 0
              ? `Each delivery on ${form.name || "this channel"} is charged ${money(Number(form.deliveryCharge))} plus GST at the food's rate${
                  Number(form.deliveryFreeAbove) > 0 ? `, free when the food comes to ${money(Number(form.deliveryFreeAbove))} or more` : ""
                }. A manager can waive it on an order.`
              : "Leave at 0 when the guest pays no delivery charge (Swiggy and Zomato collect their own)."}
          </span>
        </div>

        <div className="field">
          <span>Colour on the board</span>
          <div className="dlv-swatches" role="radiogroup" aria-label="Colour">
            {COLORS.map((color) => (
              <button
                type="button"
                key={color}
                role="radio"
                aria-checked={form.color === color}
                aria-label={color}
                title={color}
                className={`dlv-swatch sw-${color} ${form.color === color ? "is-active" : ""}`}
                onClick={() => setForm({ ...form, color })}
              />
            ))}
          </div>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.status === "active"}
            onChange={(event) => setForm({ ...form, status: event.target.checked ? "active" : "inactive" })}
          />
          Taking orders — switched-off channels stay in the report but cannot be picked for new orders
        </label>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : channel.id ? "Save channel" : "Add channel"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
