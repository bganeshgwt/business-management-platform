import { cardLayout } from "./gridModel";

// The phone layout of a grid: one card per row. The row's name is the
// heading, its serial number ("#12") above it, a few labelled lines under it,
// and its actions at the bottom right where a thumb reaches them. An entry
// table (variant "editor") stacks every input with its label instead.
//
// A list of cards rather than a restyled table: a table forced into blocks
// loses its row and cell meaning for a screen reader, while a list of labelled
// lines keeps every value next to its name.

const INTERACTIVE = "a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [role='checkbox']";

export default function GridCards({
  items,
  columns,
  editor,
  firstSerial,
  serial,
  selectable,
  canSelect,
  selected,
  onToggleRow,
  onRowClick,
  activeKey,
  onActivate,
  rowClassName,
  renderCell,
  titleText,
  onEditorKeyDown,
  caption,
}) {
  const layout = cardLayout(columns);
  const fields = editor ? columns.filter((column) => column.type !== "actions" && column.mobile !== "hide") : layout.show;

  const onKeyDown = (event, item) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      onRowClick(item.row);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
      next?.focus();
    }
  };

  const onClick = (event, item) => {
    const inner = event.target.closest(INTERACTIVE);

    if ((inner && inner !== event.currentTarget) || window.getSelection()?.toString()) {
      return;
    }

    onRowClick(item.row);
  };

  return (
    <ul className={`dg-cards ${editor ? "is-editor" : ""}`} role="list" aria-label={caption} onKeyDown={editor ? onEditorKeyDown : undefined}>
      {items.map((item, position) => {
        const number = firstSerial + position;
        const isSelected = selectable && selected.has(item.key);
        const clickable = Boolean(onRowClick);
        const extra = rowClassName ? rowClassName(item.row) || "" : "";
        const tabbable = activeKey === undefined || activeKey === null ? position === 0 : activeKey === item.key;

        return (
          <li
            key={item.key}
            className={`dg-card ${extra} ${isSelected ? "is-selected" : ""} ${clickable ? "is-clickable" : ""}`}
            data-row={number}
            tabIndex={clickable ? (tabbable ? 0 : -1) : undefined}
            onClick={clickable ? (event) => onClick(event, item) : undefined}
            onKeyDown={clickable ? (event) => onKeyDown(event, item) : undefined}
            onFocus={clickable ? (event) => event.target === event.currentTarget && onActivate(item.key) : undefined}
          >
            <div className="dg-card-head">
              {selectable && (
                <input
                  type="checkbox"
                  className="dg-check"
                  checked={isSelected}
                  onChange={() => onToggleRow(item.key)}
                  disabled={canSelect ? !canSelect(item) : false}
                  aria-label={`Select ${titleText(item) || `row ${number}`}`}
                />
              )}
              <div className="dg-card-titles">
                {serial && <span className="dg-card-serial">{editor ? `Line ${number}` : `#${number}`}</span>}
                {!editor && layout.title && (
                  <div className="dg-card-title" data-col={layout.title.key}>
                    {renderCell(layout.title, item, number, true)}
                  </div>
                )}
                {!editor &&
                  layout.subtitles.map((column) => (
                    <div key={column.key} className="dg-card-subtitle" data-col={column.key}>
                      {renderCell(column, item, number, true)}
                    </div>
                  ))}
              </div>
            </div>

            {fields.length > 0 &&
              (editor ? (
                <div className="dg-card-inputs">
                  {fields.map((column) => (
                    <label key={column.key} className={`dg-card-input align-${column.align}`} data-col={column.key}>
                      <span className="dg-card-label">{column.label}</span>
                      {renderCell(column, item, number, true)}
                    </label>
                  ))}
                </div>
              ) : (
                <dl className="dg-card-fields">
                  {fields.map((column) => (
                    <div key={column.key} className={`dg-card-field align-${column.align}`} data-col={column.key}>
                      <dt>{column.label}</dt>
                      <dd>{renderCell(column, item, number, true)}</dd>
                    </div>
                  ))}
                </dl>
              ))}

            {layout.actions.length > 0 && (
              <div className="dg-card-actions">
                {layout.actions.map((column) => (
                  <div key={column.key} className="dg-card-action" data-col={column.key}>
                    {renderCell(column, item, number, true)}
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
