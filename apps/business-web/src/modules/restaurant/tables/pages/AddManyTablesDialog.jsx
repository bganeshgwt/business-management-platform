import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { createTables, listTables } from "../services/table.service";
import { nextNumber, rowsOf, tablesOf } from "./manyTables";

// "Add many tables": a whole floor in one go. Each row is a run of tables
// that share their seats, floor and area (T1 to T10, 4 seats, First Floor);
// a second row carries on the numbers (T11 to T14, 6 seats, Window). The
// numbers it will make are listed before saving, any the restaurant already
// has are named, and the server adds all of them or none.
const MOST = 200;

export default function AddManyTablesDialog({ floors, areas, startFloorId, outletField, onClose, onSaved }) {
  const [existing, setExisting] = useState(null);
  const [groups, setGroups] = useState(() => [
    { prefix: "T", from: "1", count: "10", capacity: "4", floorId: String(startFloorId || floors[0]?.id || ""), areaId: "" },
  ]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // A first number typed by hand is never moved by the list arriving late.
  const typedFrom = useRef(false);

  // Every table the restaurant has (all floors), to start after the numbers in use.
  useEffect(() => {
    let current = true;

    listTables()
      .then((rows) => {
        if (!current) return;
        setExisting(rows);
        if (!typedFrom.current) {
          setGroups((list) => (list.length === 1 ? [{ ...list[0], from: String(nextNumber(rows, list[0].prefix)) }] : list));
        }
      })
      .catch(() => current && setExisting([]));

    return () => {
      current = false;
    };
  }, []);

  const tables = useMemo(() => tablesOf(groups), [groups]);
  const taken = useMemo(() => {
    const have = new Set((existing || []).map((table) => table.tableNo.toLowerCase()));

    return tables.filter((table) => have.has(table.tableNo.toLowerCase())).map((table) => table.tableNo);
  }, [tables, existing]);
  const twice = useMemo(() => {
    const seen = new Set();
    const again = new Set();

    tables.forEach((table) => {
      const key = table.tableNo.toLowerCase();
      if (seen.has(key)) again.add(table.tableNo);
      seen.add(key);
    });

    return [...again];
  }, [tables]);

  const areasFor = (floorId) => areas.filter((area) => String(area.floorId) === String(floorId));
  const floorName = (id) => floors.find((floor) => String(floor.id) === String(id))?.name || "";
  const areaName = (id) => areas.find((area) => String(area.id) === String(id))?.name || "";

  const change = (index, field) => (event) => {
    const value = event.target.value;

    if (field === "from") typedFrom.current = true;
    setGroups((list) =>
      list.map((group, at) => {
        if (at !== index) return group;
        const next = { ...group, [field]: value, ...(field === "floorId" ? { areaId: "" } : {}) };

        // A new prefix starts after that prefix's numbers in use (only the first row; later rows carry on).
        if (field === "prefix" && index === 0 && existing) next.from = String(nextNumber(existing, value));
        return next;
      })
    );
  };

  // The next row carries on the numbers and the floor of the last one.
  const addRow = () =>
    setGroups((list) => {
      const last = list[list.length - 1];
      const from = (Number(last.from) || 1) + (Number(last.count) || 0);

      return [...list, { ...last, from: String(from), count: "4", areaId: last.areaId }];
    });

  const removeRow = (index) => setGroups((list) => list.filter((_, at) => at !== index));

  const tooMany = tables.length > MOST;
  const blocked = !tables.length || tooMany || taken.length > 0 || twice.length > 0;

  const save = async (event) => {
    event.preventDefault();
    setError("");

    if (blocked) return;
    setSaving(true);

    try {
      const result = await createTables(tables.map((table) => ({ ...table, ...outletField.payload })));

      onSaved(`${result.created} tables added: ${result.tableNos[0]} to ${result.tableNos[result.tableNos.length - 1]}`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add many tables"
      description="Each row is a run of tables with the same seats, floor and area. Add a row for tables of another size or place."
      icon="table"
      width={880}
      onClose={onClose}
      dismissible={!saving}
    >
      <form className="mt-form" onSubmit={save}>
        <ErrorMessage message={error} />

        <div className="mt-rows">
          {groups.map((group, index) => {
            const run = rowsOf(group);

            return (
              <fieldset key={index} className="mt-row">
                <legend className="mt-row-title">
                  Row {index + 1}
                  <span className="muted">
                    {run.length ? ` · ${run[0]}${run.length > 1 ? ` to ${run[run.length - 1]}` : ""} (${run.length} ${run.length === 1 ? "table" : "tables"})` : ""}
                  </span>
                </legend>
                <label className="field">
                  <span>Starts with</span>
                  <input value={group.prefix} onChange={change(index, "prefix")} maxLength={10} placeholder="T" />
                </label>
                <label className="field">
                  <span>First number *</span>
                  <input type="number" min="0" max="9999" required value={group.from} onChange={change(index, "from")} />
                </label>
                <label className="field">
                  <span>How many *</span>
                  <input type="number" min="1" max={MOST} required value={group.count} onChange={change(index, "count")} />
                </label>
                <label className="field">
                  <span>Seats each *</span>
                  <input type="number" min="1" max="100" required value={group.capacity} onChange={change(index, "capacity")} />
                </label>
                <label className="field">
                  <span>Floor *</span>
                  <select required value={group.floorId} onChange={change(index, "floorId")}>
                    {floors.map((floor) => (
                      <option key={floor.id} value={floor.id}>
                        {floor.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Area</span>
                  <select value={group.areaId} onChange={change(index, "areaId")}>
                    <option value="">No area</option>
                    {areasFor(group.floorId).map((area) => (
                      <option key={area.id} value={area.id}>
                        {area.name}
                      </option>
                    ))}
                  </select>
                </label>
                {groups.length > 1 && (
                  <button
                    type="button"
                    className="icon-button mt-remove"
                    onClick={() => removeRow(index)}
                    aria-label={`Remove row ${index + 1}`}
                    title="Remove this row"
                  >
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </fieldset>
            );
          })}
        </div>

        <button type="button" className="button button-secondary mt-add" onClick={addRow}>
          <Icon name="plus" size={16} /> Add a row
        </button>

        {outletField.element}

        <section className="mt-preview" aria-label="Tables to add">
          <p className="mt-preview-title">
            <strong>
              {tables.length} {tables.length === 1 ? "table" : "tables"} to add
            </strong>
            {tables.length > 0 && <span className="muted"> · {tables.reduce((sum, table) => sum + table.capacity, 0)} seats in all</span>}
          </p>
          {tables.length > 0 && (
            <ul className="mt-chips">
              {tables.slice(0, 60).map((table, at) => (
                <li
                  key={`${at}-${table.tableNo}`}
                  className={`mt-chip${taken.includes(table.tableNo) || twice.includes(table.tableNo) ? " is-bad" : ""}`}
                  title={`${table.capacity} seats · ${floorName(table.floorId)}${table.areaId ? ` · ${areaName(table.areaId)}` : ""}`}
                >
                  {table.tableNo}
                  <small>{table.capacity}</small>
                </li>
              ))}
              {tables.length > 60 && <li className="mt-chip muted">and {tables.length - 60} more</li>}
            </ul>
          )}
          {taken.length > 0 && (
            <p className="alert alert-danger" role="alert">
              {taken.length === 1 ? "Table" : "Tables"} {taken.join(", ")} already {taken.length === 1 ? "exists" : "exist"}. Change
              the first number or what they start with.
            </p>
          )}
          {twice.length > 0 && (
            <p className="alert alert-danger" role="alert">
              {twice.join(", ")} {twice.length === 1 ? "comes" : "come"} in two rows. Change a row's first number.
            </p>
          )}
          {tooMany && <p className="alert alert-danger" role="alert">Add up to {MOST} tables at a time.</p>}
          <p className="muted small">New tables are in service at once. Change one later from its card, as before.</p>
        </section>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving || blocked || existing === null}>
            {saving ? "Adding…" : `Add ${tables.length} ${tables.length === 1 ? "table" : "tables"}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
