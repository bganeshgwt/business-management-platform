import { useMemo, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import StatTile from "../../../../components/StatTile";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage } from "../../../../components/Feedback";
import { revisePrices } from "../services/menu.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "../../../../services/format";
import "../../../../styles/menu.css";

// The yearly price rise in one step: "+8% on Starters and Mains, rounded to
// the nearest ₹5". Sizes move by the same rule. Nothing is saved until the
// preview has been seen, and only what the preview showed is saved: the
// server checks the preview's fingerprint, so a price someone edited in the
// meantime stops the revision instead of being overwritten.

const ROUNDING = [
  { value: "0", label: "Don't round (keep paise)" },
  { value: "1", label: "Nearest ₹1" },
  { value: "5", label: "Nearest ₹5" },
  { value: "10", label: "Nearest ₹10" },
];

const percentChange = (from, to) => (from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null);

export default function PriceRevisionModal({ categories, currency = "₹", onClose, onApplied }) {
  const active = categories.filter((category) => category.status === "active");

  const [chosen, setChosen] = useState([]);
  const [mode, setMode] = useState("percent");
  const [value, setValue] = useState("");
  const [roundTo, setRoundTo] = useState("5");
  const [direction, setDirection] = useState("nearest");
  const [includeSizes, setIncludeSizes] = useState(true);
  const [preview, setPreview] = useState(null);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Any change to the rule throws the preview away: what is applied must be
  // what was last shown.
  const edit = (setter) => (next) => {
    setter(next);
    setPreview(null);
    setProblems([]);
    setNotice("");
  };

  const payload = () => ({
    categoryIds: chosen,
    mode,
    value: Number(value),
    roundTo: Number(roundTo),
    direction,
    includeSizes,
  });

  const runPreview = async () => {
    setError("");
    setProblems([]);
    setBusy(true);

    try {
      const result = await revisePrices({ ...payload(), dryRun: true });

      // A preview that finds prices going below zero still answers: it
      // lists them, and nothing can be applied until the rule is changed.
      if (result.data.ok) {
        setPreview(result.data);
      } else {
        setProblems(result.data.problems);
        setPreview(null);
      }
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.problems) {
        setProblems(response.data.problems);
        setPreview(null);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setError("");
    setBusy(true);

    try {
      const result = await revisePrices({ ...payload(), dryRun: false, fingerprint: preview.fingerprint });
      onApplied(`${result.message}: ${result.data.rule}`);
    } catch (err) {
      const response = err.response && err.response.data;

      if (err.response && err.response.status === 409) {
        setNotice(response ? response.message : "Prices changed since the preview.");
        setBusy(false);
        await runPreview();
        return;
      }

      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleCategory = (id) =>
    edit(setChosen)(chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id]);

  const stats = useMemo(() => {
    if (!preview || preview.dishes.length === 0) {
      return null;
    }

    const before = preview.dishes.reduce((sum, dish) => sum + dish.from, 0);
    const after = preview.dishes.reduce((sum, dish) => sum + dish.to, 0);

    return {
      average: percentChange(before, after),
      sizes: preview.dishes.reduce((sum, dish) => sum + dish.sizes.filter((size) => size.from !== size.to).length, 0),
    };
  }, [preview]);
  const valueNumber = Number(value);
  const canPreview = value !== "" && Number.isFinite(valueNumber) && valueNumber !== 0 && !busy;

  return (
    <Modal
      title="Revise prices"
      description="Raise or lower prices for whole categories at once, after seeing every new price."
      icon="percent"
      onClose={onClose}
      width={960}
      footer={
        <>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={apply}
            disabled={!preview || preview.dishes.length === 0 || busy}
          >
            {busy && preview ? "Saving…" : preview ? `Apply ${count(preview.changed)} new price${preview.changed === 1 ? "" : "s"}` : "Apply"}
          </button>
        </>
      }
    >
      <div className="stack mnu-revise">
        <ErrorMessage message={error} />
        {notice && <div className="alert alert-notice">{notice}</div>}

        <p className="mnu-lead">
          <Icon name="info" size={16} />
          <span>
            Sizes change by the same rule, and you see every new price before anything is saved. Archived dishes are
            left alone. Every change goes in the activity log.
          </span>
        </p>

        <div className="mnu-revise-grid">
          <fieldset className="field mnu-panel mnu-revise-cats">
            <legend>1 · Which categories</legend>
            <label className="checkbox mnu-whole-menu">
              <input type="checkbox" checked={chosen.length === 0} onChange={() => edit(setChosen)([])} />
              <span>
                <strong>Whole menu</strong>
              </span>
            </label>
            <div className="mnu-cat-grid">
              {active.map((category) => (
                <label className="checkbox" key={category.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(category.id)}
                    onChange={() => toggleCategory(category.id)}
                  />
                  <span>
                    {category.name} <span className="muted small">{category.productCount}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="field mnu-panel mnu-revise-rule">
            <legend>2 · The rule</legend>
            <div className="field">
              <span>Change by</span>
              <div className="segmented" role="radiogroup" aria-label="Change by">
                <button
                  type="button"
                  className={`segment${mode === "percent" ? " is-active" : ""}`}
                  aria-pressed={mode === "percent"}
                  onClick={() => edit(setMode)("percent")}
                >
                  Percentage
                </button>
                <button
                  type="button"
                  className={`segment${mode === "amount" ? " is-active" : ""}`}
                  aria-pressed={mode === "amount"}
                  onClick={() => edit(setMode)("amount")}
                >
                  Amount ({currency})
                </button>
              </div>
            </div>

            <label className="field">
              <span>{mode === "percent" ? "Percentage" : `Amount (${currency})`}</span>
              <input
                type="number"
                step={mode === "percent" ? "0.5" : "1"}
                value={value}
                onChange={(event) => edit(setValue)(event.target.value)}
                placeholder={mode === "percent" ? "8" : "20"}
              />
              <small className="muted">Use a minus sign to lower prices, e.g. {mode === "percent" ? "-5" : "-10"}.</small>
            </label>

            <div className="mnu-revise-round">
              <label className="field">
                <span>Round the new price</span>
                <select value={roundTo} onChange={(event) => edit(setRoundTo)(event.target.value)}>
                  {ROUNDING.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {roundTo !== "0" && (
                <label className="field">
                  <span>Direction</span>
                  <select value={direction} onChange={(event) => edit(setDirection)(event.target.value)}>
                    <option value="nearest">Nearest</option>
                    <option value="up">Always up</option>
                    <option value="down">Always down</option>
                  </select>
                </label>
              )}
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeSizes}
                onChange={(event) => edit(setIncludeSizes)(event.target.checked)}
              />
              <span>Sizes (Half / Full) change by the same rule</span>
            </label>

            <div className="mnu-revise-go">
              <button type="button" className="button button-secondary" onClick={runPreview} disabled={!canPreview}>
                <Icon name="eye" size={16} />
                {busy && !preview ? "Working…" : preview ? "Preview again" : "Preview new prices"}
              </button>
            </div>
          </fieldset>
        </div>

        {problems.length > 0 && (
          <div className="stack">
            <div className="alert">
              {problems.length} dish{problems.length === 1 ? "" : "es"} would end up below zero. Nothing was changed.
            </div>
            <ul className="mnu-problem-list">
              {problems.slice(0, 20).map((problem) => (
                <li key={problem.productId}>{problem.message}</li>
              ))}
            </ul>
          </div>
        )}

        {preview && (
          <>
            <div className="stat-grid mnu-mini-stats">
              <StatTile size="sm" icon="edit" tone="primary" label="Dishes changing" value={count(preview.changed)} />
              <StatTile size="sm" icon="layers" tone="info" label="Sizes changing" value={stats ? count(stats.sizes) : 0} />
              <StatTile size="sm" icon="check" label="Stay the same" value={count(preview.unchanged)} />
              <StatTile
                size="sm"
                icon={stats && stats.average !== null && stats.average < 0 ? "trend-down" : "trend-up"}
                tone="neutral"
                label="Average change after rounding"
                value={stats && stats.average !== null ? `${stats.average > 0 ? "+" : ""}${stats.average}%` : "—"}
              />
            </div>

            <p className="mnu-rule">
              <Icon name="sparkles" size={16} />
              <span>{preview.rule}</span>
            </p>

            {preview.dishes.length === 0 ? (
              <p className="mnu-lead">
                <Icon name="info" size={16} />
                <span>No price would change with that rule.</span>
              </p>
            ) : (
              // Every dish the rule moves, a page at a time (a whole menu can be thousands).
              <DataGrid
                id="menu-price-revision"
                variant="compact"
                caption="New prices, dish by dish"
                rows={preview.dishes}
                rowKey={(dish) => dish.productId}
                rowNoun={["dish", "dishes"]}
                currency={currency}
                columns={[
                  {
                    key: "dish",
                    header: "Dish",
                    value: (dish) => dish.name,
                    mobile: "title",
                    width: 260,
                    render: (dish) => (
                      <>
                        <div className="mnu-dish">{dish.name}</div>
                        {dish.sizes.length > 0 && (
                          <div className="muted small">
                            {dish.sizes
                              .map((size) => `${size.name} ${money(size.from, currency)} → ${money(size.to, currency)}${size.active ? "" : " (switched off)"}`)
                              .join(" · ")}
                          </div>
                        )}
                        {(dish.skippedSizes || []).length > 0 && (
                          <div className="muted small">
                            Left as it is: {dish.skippedSizes.map((size) => size.name).join(", ")} (switched off, and
                            priced below zero — give {dish.skippedSizes.length === 1 ? "it" : "them"} a price under
                            Sizes &amp; add-ons before switching back on)
                          </div>
                        )}
                      </>
                    ),
                  },
                  { key: "category", header: "Category", value: (dish) => dish.categoryName, mobile: "subtitle" },
                  { key: "now", header: "Now", type: "money", value: (dish) => dish.from, mobile: "show" },
                  {
                    key: "new",
                    header: "New",
                    type: "money",
                    value: (dish) => dish.to,
                    mobile: "show",
                    render: (dish) => <strong>{money(dish.to, currency)}</strong>,
                  },
                  {
                    key: "change",
                    header: "Change",
                    type: "money",
                    value: (dish) => dish.to - dish.from,
                    mobile: "show",
                    render: (dish) => {
                      const pct = percentChange(dish.from, dish.to);

                      return (
                        <span className={`nowrap ${dish.to >= dish.from ? "text-success" : "text-danger"}`}>
                          {dish.to >= dish.from ? "+" : "−"}
                          {money(Math.abs(dish.to - dish.from), currency)}
                          {pct !== null && <span className="muted small"> ({pct > 0 ? "+" : ""}{pct}%)</span>}
                        </span>
                      );
                    },
                  },
                ]}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
