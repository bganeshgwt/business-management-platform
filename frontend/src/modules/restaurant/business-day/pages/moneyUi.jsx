import Icon from "../../../../components/Icon";
// The tab bar's sliding underline (and the cash screens' own pieces).
import "../../../../styles/cash.css";

// Small pieces the money screens share (Bills, Business day, Discounts,
// Expenses), so a tab or a status chip reads the same on each. The date
// wording they share is in moneyText.js.

// The sections of a screen as underlined tabs, each with an icon and, where
// it helps, a count in a small pill. The underline glides to the tab chosen
// (data-motion-tabs: the shared motion system; off with reduced motion).
export function MoneyTabs({ tabs, active, onChange, label }) {
  return (
    <div className="money-tabs" role="tablist" aria-label={label} data-motion-tabs>
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.key}
          aria-selected={active === tab.key}
          className={`money-tab ${active === tab.key ? "is-active" : ""}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.icon && <Icon name={tab.icon} size={16} />}
          {tab.label}
          {tab.count !== undefined && tab.count !== null && <span className="money-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

// A status as colour, a dot and a word.
export function Status({ tone, children }) {
  return (
    <span className={`badge badge-${tone} status-badge`}>
      <span className="badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
