import ActionMenu from "../../../../../components/ActionMenu";

// A table's actions in a panel row: its own action and the next most likely
// one as buttons, anything rarer (and anything that cannot be undone, like
// cancelling an order) in the "⋯" menu, so a row never becomes a wall of
// buttons and the dangerous one is never a stray click away.
export default function FloorActionButtons({ actions, busy, tableId, menuLabel = "More for this table" }) {
  if (actions.length === 0) {
    return null;
  }

  const working = Boolean(busy && busy.endsWith(`-${tableId}`));
  const plain = actions.filter((action) => !action.danger);
  const buttons = plain.slice(0, 2);
  const rest = [...plain.slice(2), ...actions.filter((action) => action.danger)];

  return (
    <span className="panel-row-actions floor-row-actions">
      {buttons.map((action) => (
        <button
          key={action.key}
          type="button"
          className={`button button-sm ${action.primary ? "" : "button-secondary"}`}
          onClick={action.onClick}
          disabled={working}
        >
          {action.label}
        </button>
      ))}
      {rest.length > 0 && (
        <ActionMenu
          label={menuLabel}
          items={rest.map((action) => ({ label: action.label, onClick: action.onClick, danger: action.danger, disabled: working }))}
        />
      )}
    </span>
  );
}
