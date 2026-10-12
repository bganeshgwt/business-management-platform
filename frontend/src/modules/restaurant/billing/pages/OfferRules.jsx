import { useEffect, useMemo, useState } from "react";
import { listCategories, listProducts } from "../../menu/services/menu.service";
import { WEEKDAYS } from "./offerRulesText";

// The rules an offer can carry (sweep SW-B-17), as part of the offer form:
// what kind of offer, which dishes or categories, which days and hours, and
// once per guest. The till checks every rule and says in words why a coupon
// does not apply.

export default function OfferRules({ value, onChange }) {
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [find, setFind] = useState("");
  const [catFind, setCatFind] = useState("");
  const set = (patch) => onChange({ ...value, ...patch });

  useEffect(() => {
    listCategories()
      .then((rows) => setCategories((Array.isArray(rows) ? rows : rows.items || []).filter((row) => row.status !== "inactive")))
      .catch(() => setCategories([]));
    listProducts({ status: "active" })
      .then((rows) => setProducts(Array.isArray(rows) ? rows : rows.items || []))
      .catch(() => setProducts([]));
  }, []);

  const term = find.trim().toLowerCase();
  const matches = useMemo(
    () =>
      term
        ? products.filter((dish) => dish.name.toLowerCase().includes(term) && !value.productIds.includes(Number(dish.id))).slice(0, 12)
        : [],
    [products, term, value.productIds]
  );
  const chosenDishes = products.filter((dish) => value.productIds.includes(Number(dish.id)));
  // A menu with many categories gets the same type-to-add box as dishes.
  const manyCats = categories.length > 16;
  const catTerm = catFind.trim().toLowerCase();
  const catMatches = catTerm
    ? categories
        .filter((category) => category.name.toLowerCase().includes(catTerm) && !value.categoryIds.includes(Number(category.id)))
        .slice(0, 10)
    : [];
  const chosenCats = categories.filter((category) => value.categoryIds.includes(Number(category.id)));
  const toggle = (list, id) => (list.includes(id) ? list.filter((one) => one !== id) : [...list, id]);
  const buyGet = value.offerType === "buy_get";

  return (
    <>
      <p className="section-heading field-wide">Kind of offer</p>

      <div className="field field-wide">
        <div className="segmented" role="radiogroup" aria-label="Kind of offer">
          {[
            ["discount", "Money or % off"],
            ["buy_get", "Buy X, get Y"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              role="radio"
              aria-checked={value.offerType === key}
              className={`segment ${value.offerType === key ? "is-active" : ""}`}
              onClick={() => set({ offerType: key })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {buyGet && (
        <>
          <label className="field">
            <span>Buy *</span>
            <input type="number" min="1" max="50" step="1" value={value.buyQuantity} onChange={(e) => set({ buyQuantity: e.target.value })} required />
          </label>
          <label className="field">
            <span>Get *</span>
            <input type="number" min="1" max="50" step="1" value={value.getQuantity} onChange={(e) => set({ getQuantity: e.target.value })} required />
          </label>
          <label className="field">
            <span>Off the ones they get (%)</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={value.getDiscountPercent}
              onChange={(e) => set({ getDiscountPercent: e.target.value })}
              required
            />
            <small className="muted">100 = free. The cheapest of the offer&apos;s dishes are the ones given.</small>
          </label>
        </>
      )}

      <p className="section-heading field-wide">On which dishes</p>

      <div className="field field-wide">
        <span>Categories</span>
        {manyCats ? (
          <>
            <input
              type="search"
              value={catFind}
              onChange={(event) => setCatFind(event.target.value)}
              placeholder="Type to add a category"
              aria-label="Find a category to add"
            />
            {catMatches.length > 0 && (
              <div className="offer-rule-matches" role="listbox" aria-label="Categories found">
                {catMatches.map((category) => (
                  <button
                    type="button"
                    key={category.id}
                    className="offer-rule-match"
                    onClick={() => {
                      set({ categoryIds: [...value.categoryIds, Number(category.id)] });
                      setCatFind("");
                    }}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            )}
            {chosenCats.length > 0 && (
              <div className="offer-rule-chips">
                {chosenCats.map((category) => (
                  <button
                    type="button"
                    key={category.id}
                    className="chip-button is-active"
                    onClick={() => set({ categoryIds: value.categoryIds.filter((id) => id !== Number(category.id)) })}
                    aria-label={`Take ${category.name} off the offer`}
                  >
                    {category.name} ✕
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="offer-rule-chips" role="group" aria-label="Categories">
            {categories.length === 0 && <span className="muted small">No categories yet</span>}
            {categories.map((category) => {
              const on = value.categoryIds.includes(Number(category.id));
              return (
                <button
                  type="button"
                  key={category.id}
                  aria-pressed={on}
                  className={`chip-button ${on ? "is-active" : ""}`}
                  onClick={() => set({ categoryIds: toggle(value.categoryIds, Number(category.id)) })}
                >
                  {category.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="field field-wide">
        <span>Dishes</span>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Type to add a dish"
          aria-label="Find a dish to add"
        />
        {matches.length > 0 && (
          <div className="offer-rule-matches" role="listbox" aria-label="Dishes found">
            {matches.map((dish) => (
              <button
                type="button"
                key={dish.id}
                className="offer-rule-match"
                onClick={() => {
                  set({ productIds: [...value.productIds, Number(dish.id)] });
                  setFind("");
                }}
              >
                {dish.name}
                <span className="muted small">{dish.categoryName}</span>
              </button>
            ))}
          </div>
        )}
        {chosenDishes.length > 0 && (
          <div className="offer-rule-chips">
            {chosenDishes.map((dish) => (
              <button
                type="button"
                key={dish.id}
                className="chip-button is-active"
                onClick={() => set({ productIds: value.productIds.filter((id) => id !== Number(dish.id)) })}
                aria-label={`Take ${dish.name} off the offer`}
              >
                {dish.name} ✕
              </button>
            ))}
          </div>
        )}
        <small className="muted">
          {value.productIds.length || value.categoryIds.length
            ? "Only these dishes count toward the offer and are discounted."
            : buyGet
              ? "Pick the dishes or categories the offer is on."
              : "None picked: the whole bill."}
        </small>
      </div>

      <p className="section-heading field-wide">Days and hours</p>

      <div className="field field-wide">
        <span>Days</span>
        <div className="offer-rule-chips" role="group" aria-label="Days">
          {WEEKDAYS.map((day) => {
            const on = value.weekdays.includes(day.value);
            return (
              <button
                type="button"
                key={day.value}
                aria-pressed={on}
                className={`chip-button ${on ? "is-active" : ""}`}
                onClick={() => set({ weekdays: toggle(value.weekdays, day.value) })}
              >
                {day.short}
              </button>
            );
          })}
        </div>
        <small className="muted">None picked: every day (by the business day, so 12:30 am is still the evening before).</small>
      </div>

      <label className="field">
        <span>From</span>
        <input type="time" value={value.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} />
      </label>
      <label className="field">
        <span>To</span>
        <input type="time" value={value.timeTo} onChange={(e) => set({ timeTo: e.target.value })} />
        <small className="muted">Empty: all day. 10 pm to 1 am runs past midnight.</small>
      </label>

      <label className="checkbox field-wide">
        <input type="checkbox" checked={value.oncePerGuest} onChange={(e) => set({ oncePerGuest: e.target.checked })} />
        <span>Once per guest (the guest must be on the order)</span>
      </label>
    </>
  );
}
