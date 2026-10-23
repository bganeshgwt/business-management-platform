import Icon from "@bmp/ui/Icon";

// Where a delivery is going, taken at the till with the order: which channel
// it came in on (Swiggy, Zomato, a phone call, our own riders), the address
// and a landmark the rider can find, the partner's own order number, and
// what was promised. Saved onto the order for the Deliveries board
// (services/posDelivery.js has the rules).
// A known guest's saved addresses are offered above the address
// box, newest used first: one tap fills it. A new address typed for a known
// guest is kept on them under the label chosen here.
const LABELS = ["Home", "Office", "Other"];

export default function DeliveryFields({ channels, value, onChange, guest = null }) {
  const channel = channels.find((one) => String(one.id) === String(value.channelId)) || null;
  const set = (field) => (event) => onChange({ ...value, [field]: event.target.value });
  // Typing over a picked address makes it a new one.
  const type = (field) => (event) => onChange({ ...value, savedAddressId: null, [field]: event.target.value });
  const saved = (guest && guest.addresses) || [];
  const picked = saved.find((one) => one.id === value.savedAddressId) || null;
  const pick = (one) =>
    onChange({
      ...value,
      savedAddressId: one.id,
      address: one.address,
      landmark: one.landmark || "",
      addressLabel: "",
    });

  return (
    <div className="pos-delivery">
      <p className="pos-delivery-head">
        <Icon name="scooter" size={16} />
        Where it is going
      </p>

      <label className="field">
        <span>Came in on</span>
        <select value={value.channelId} onChange={set("channelId")}>
          <option value="">Our own delivery</option>
          {channels.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      </label>

      {channel && channel.type === "aggregator" && (
        <label className="field">
          <span>{channel.name} order ID</span>
          <input value={value.externalRef} onChange={set("externalRef")} maxLength={60} placeholder="From the partner's tablet" />
        </label>
      )}

      <label className="field">
        <span>Promised in (minutes)</span>
        <input type="number" min="5" max="240" inputMode="numeric" value={value.etaMinutes} onChange={set("etaMinutes")} placeholder="40" />
      </label>

      {saved.length > 0 && (
        <div className="pos-delivery-wide pos-saved-addresses">
          <span className="pos-saved-head">{guest.name}'s addresses</span>
          <div className="pos-saved-list">
            {saved.map((one) => (
              <button
                key={one.id}
                type="button"
                className={`pos-saved-address ${value.savedAddressId === one.id ? "is-picked" : ""}`}
                aria-pressed={value.savedAddressId === one.id}
                onClick={() => pick(one)}
              >
                <strong>
                  <Icon name={one.label === "Office" ? "store" : "home"} size={13} /> {one.label}
                </strong>
                <span>{one.address}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {picked && picked.masked ? (
        <div className="pos-delivery-wide pos-saved-masked">
          <p>
            <strong>{picked.label}</strong> · {picked.address}
          </p>
          <p className="muted small">
            The full address goes on the delivery when you save; only managers see it here.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => onChange({ ...value, savedAddressId: null, address: "", landmark: "" })}
            >
              Type a different address
            </button>
          </p>
        </div>
      ) : (
        <>
          <label className="field pos-delivery-wide">
            <span>Address</span>
            <textarea rows={2} value={value.address} onChange={type("address")} maxLength={500} placeholder="Flat, building, street, area" />
          </label>
          <label className="field pos-delivery-wide">
            <span>Landmark</span>
            <span className="input-with-icon">
              <Icon name="map-pin" size={16} className="input-icon" />
              <input value={value.landmark} onChange={type("landmark")} maxLength={200} placeholder="Opposite the bank, near the temple…" />
            </span>
          </label>
          {guest && guest.id && !value.savedAddressId && value.address.trim() && (
            <div className="field pos-delivery-wide">
              <span>Keep for {guest.name} as</span>
              <div className="segmented pos-address-label" role="radiogroup" aria-label="Address label">
                {LABELS.map((label) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={(value.addressLabel || "Home") === label}
                    className={`segment ${(value.addressLabel || "Home") === label ? "is-active" : ""}`}
                    onClick={() => onChange({ ...value, addressLabel: label })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
