import { useEffect, useState } from "react";
import { listCustomers } from "../../crm/services/crm.service";
import { lookupGuestByMobile } from "../services/order.service";
import { mobileHint, normaliseMobile } from "../../../../services/phone";
import { dayMonth } from "../../../../services/floorTables";
import Icon from "../../../../components/Icon";
import GuestOccasion from "../../crm/pages/GuestOccasion";

const TAG_WORDS = {
  vip: "VIP",
  allergy: "Allergy",
  jain: "Jain",
  vegan: "Vegan",
  corporate: "Corporate",
  family: "Family",
  blogger: "Blogger",
};


// The guest on the order, found from the mobile typed at the till.
//
// Staff type the number and expect the till to know the regular: typing a
// mobile (+91, 0 and spaces are fine) looks it up and shows who it is, how
// often they come and what they have in points, and the order is theirs. A
// number nobody has, with a name, is signed up in the guest book when the
// order is saved. Captains get this too: they take the mobile at the table.
// Staff who may read the guest book can also find a regular by name.
export default function GuestBox({
  customer,
  setCustomer,
  customerName,
  setCustomerName,
  customerMobile,
  setCustomerMobile,
  loyaltyOn,
  canSearchByName,
  nameLabel = "Name",
  businessDate = null,
  onRepeat = null,
}) {
  const mobile = normaliseMobile(customerMobile);
  const [lookup, setLookup] = useState({ mobile: null, status: "idle" });
  const [byName, setByName] = useState(false);
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState(null);

  // The guest behind a whole, valid number, a moment after the last digit.
  const known = customer && customer.mobile && customer.mobile === mobile && customer.visits !== undefined;

  useEffect(() => {
    if (!mobile || known) {
      return undefined;
    }

    let current = true;
    const timer = setTimeout(() => {
      lookupGuestByMobile(mobile)
        .then((data) => {
          if (!current) {
            return;
          }

          setLookup({ mobile, status: data.guest ? "found" : "new", sameDigits: data.sameDigits || null });

          if (data.guest) {
            setCustomer((shown) => ({ ...(shown && shown.id === data.guest.id ? shown : {}), ...data.guest }));
            setCustomerName((typed) => typed || data.guest.name);
          }
        })
        .catch(() => {
          if (current) {
            setLookup({ mobile, status: "error" });
          }
        });
    }, 300);

    return () => {
      current = false;
      clearTimeout(timer);
    };
    // setCustomer and setCustomerName are state setters, stable for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, known]);

  const typeMobile = (value) => {
    setCustomerMobile(value);

    // Another number is another guest.
    if (customer && (!customer.mobile || normaliseMobile(value) !== customer.mobile)) {
      setCustomer(null);
    }
  };

  const clear = () => {
    setCustomer(null);
    setCustomerMobile("");
    setCustomerName("");
    setMatches(null);
    setSearch("");
  };

  const findByName = async (event) => {
    event.preventDefault();

    if (!search.trim()) {
      return;
    }

    try {
      setMatches(await listCustomers({ search: search.trim(), limit: 8 }));
    } catch {
      setMatches([]);
    }
  };

  const pick = (row) => {
    setCustomer({ id: row.id, name: row.name, mobile: row.mobile || null, loyaltyPoints: row.loyaltyPoints || 0, tags: row.tags || [] });
    setCustomerName(row.name);

    if (row.mobile) {
      setCustomerMobile(row.mobile);
    }

    setMatches(null);
    setSearch("");
    setByName(false);
  };

  const hint = customerMobile && !mobile ? mobileHint(customerMobile) : null;
  const isNew = mobile && !customer && lookup.mobile === mobile && lookup.status === "new";
  // Somebody already has these ten digits as a number from abroad: the
  // number stays on the order, but the till does not sign up a second guest.
  const sameDigits = isNew ? lookup.sameDigits : null;

  return (
    <div className="pos-guest">
      <div className="pos-guest-row">
        <label className="field">
          <span>Guest mobile</span>
          <span className="input-with-icon">
            <Icon name="phone" size={16} className="input-icon" />
            <input
              value={customerMobile}
              onChange={(event) => typeMobile(event.target.value)}
              inputMode="tel"
              autoComplete="off"
              placeholder="Find by mobile"
            />
          </span>
        </label>
        <label className="field">
          <span>{nameLabel}</span>
          <span className="input-with-icon">
            <Icon name="user" size={16} className="input-icon" />
            <input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              autoComplete="off"
              placeholder={isNew ? "Their name, to save them" : "Guest name"}
            />
          </span>
        </label>
      </div>

      {customer ? (
        <div className="pos-guest-card">
          <span className="pos-guest-avatar" aria-hidden="true">
            {(customer.name || "G").trim().charAt(0).toUpperCase()}
          </span>
          <div className="pos-guest-facts">
            <span className="pos-guest-name">
              <strong>{customer.name}</strong>
              <GuestOccasion guest={customer} today={businessDate} />
            </span>
            <span className="muted small">
              {customer.visits !== undefined
                ? customer.visits === 0
                  ? "First visit"
                  : `${customer.visits} ${customer.visits === 1 ? "visit" : "visits"}${customer.lastVisitAt ? ` · last ${dayMonth(customer.lastVisitAt)}` : ""}`
                : "Regular"}
              {loyaltyOn ? ` · ${customer.loyaltyPoints || 0} points` : ""}
            </span>
            {((customer.tags || []).length > 0 || customer.allergies) && (
              <span className="pos-guest-tags">
                {(customer.tags || []).map((tag) => (
                  <span key={tag} className={`pos-guest-tag pos-tag-${tag}`}>
                    {TAG_WORDS[tag] || tag}
                  </span>
                ))}
                {customer.allergies && <span className="pos-guest-tag pos-tag-allergy">Allergic: {customer.allergies}</span>}
              </span>
            )}
          </div>
          <button type="button" className="button button-ghost button-sm pos-guest-remove" onClick={clear}>
            <Icon name="x" size={15} />
            Remove
          </button>
        </div>
      ) : null}

      {/* A regular's last orders, to put the same again in the cart at
          today's prices (SW-A-18). */}
      {customer && onRepeat && (customer.recentOrders || []).length > 0 ? (
        <div className="pos-guest-repeat">
          <p className="pos-guest-repeat-head">
            <Icon name="history" size={14} /> Last orders
          </p>
          <ul>
            {customer.recentOrders.map((past) => (
              <li key={past.id}>
                <span className="pos-guest-repeat-what">
                  <strong>
                    {dayMonth(past.placedAt)} · {past.orderNumber}
                  </strong>
                  <span className="muted small">
                    {past.items.map((item) => `${item.quantity} × ${item.name}`).join(", ") || "No dishes"}
                  </span>
                </span>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  disabled={past.items.length === 0}
                  onClick={() => onRepeat(past)}
                >
                  <Icon name="refresh" size={14} />
                  Repeat
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {customer ? null : sameDigits ? (
        <p className="pos-guest-status is-problem">
          <Icon name="alert" size={16} />
          <span>
            {sameDigits.name} already has these ten digits as a mobile from {sameDigits.country}. The number stays on
            this order, but no new guest is added. Check it under Customers.
          </span>
        </p>
      ) : isNew ? (
        <p className="pos-guest-status is-new">
          <Icon name="user-plus" size={16} />
          <span>
            <strong>New guest.</strong>{" "}
            {customerName.trim()
              ? `${customerName.trim()} is saved to the guest book with this order${loyaltyOn ? " and earns points from this bill" : ""}.`
              : "Add their name and they are saved to the guest book with this order."}
          </span>
        </p>
      ) : hint && !hint.ok ? (
        <p className="pos-guest-status is-problem">
          <Icon name="alert" size={16} />
          <span>{hint.text}</span>
        </p>
      ) : null}

      {canSearchByName && !customer && (
        <div className="pos-guest-byname">
          {byName ? (
            <form className="inline-form" onSubmit={findByName}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find a regular by name"
                aria-label="Find a regular by name"
              />
              <button type="submit" className="button button-secondary button-sm" disabled={!search.trim()}>
                <Icon name="search" size={15} />
                Find
              </button>
            </form>
          ) : (
            <button type="button" className="link-button small pos-guest-byname-link" onClick={() => setByName(true)}>
              <Icon name="search" size={14} />
              No mobile? Find a regular by name
            </button>
          )}

          {matches && (
            <ul className="customer-matches">
              {matches.length === 0 && <li className="muted small pos-guest-none">Nobody by that name.</li>}
              {matches.map((row) => (
                <li key={row.id}>
                  <button type="button" onClick={() => pick(row)}>
                    <strong>{row.name}</strong>
                    <span className="muted">
                      {row.mobileDisplay ? ` · ${row.mobileDisplay}` : ""}
                      {loyaltyOn ? ` · ${row.loyaltyPoints} points` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
