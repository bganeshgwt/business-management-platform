import { useEffect, useMemo, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { dayMonth } from "@bmp/shared/dates";
import { copyCaptainPlan, getCaptainPlan, saveCaptainPlan } from "../services/table.service";
import "../../../../styles/service.css";

const KINDS = [
  { value: "floor", label: "Floor" },
  { value: "area", label: "Section" },
  { value: "table", label: "Table" },
];

let nextKey = 0;
const lineOf = (row) => {
  nextKey += 1;

  return {
    key: `line-${nextKey}`,
    userId: row ? String(row.userId) : "",
    kind: row ? row.kind : "floor",
    targetId: row ? String(row.tableId || row.areaId || row.floorId) : "",
  };
};

const dayBefore = (date) => {
  const [y, m, d] = date.split("-").map(Number);

  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

// Today's captain sections: which captain has which floor, section
// or table. A table inside someone's floor can be given to another captain:
// the table's own line wins. Captains then see "My tables" on the POS, and
// QR calls for their tables come first in their inbox.
export default function CaptainPlanModal({ floors, areas, tables, canManage, onClose }) {
  const [plan, setPlan] = useState(null);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const show = (data) => {
    setPlan(data);
    setLines(data.assignments.map(lineOf));
  };

  useEffect(() => {
    getCaptainPlan()
      .then(show)
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const targets = useMemo(
    () => ({
      floor: floors.map((floor) => ({ id: floor.id, label: floor.name })),
      area: areas.map((area) => ({ id: area.id, label: area.floorName ? `${area.floorName} · ${area.name}` : area.name })),
      table: tables.map((table) => ({ id: table.id, label: `Table ${table.tableNo}${table.floorName ? ` · ${table.floorName}` : ""}` })),
    }),
    [floors, areas, tables]
  );

  const setLine = (key, field, value) =>
    setLines((all) => all.map((line) => (line.key === key ? { ...line, [field]: value, ...(field === "kind" ? { targetId: "" } : {}) } : line)));

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    try {
      const result = await saveCaptainPlan({
        date: plan.date,
        assignments: lines
          .filter((line) => line.userId && line.targetId)
          .map((line) => ({
            userId: Number(line.userId),
            [line.kind === "floor" ? "floorId" : line.kind === "area" ? "areaId" : "tableId"]: Number(line.targetId),
          })),
      });
      show(result.data);
      setMessage(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const copyYesterday = async () => {
    setError("");
    setSaving(true);

    try {
      const result = await copyCaptainPlan({ from: dayBefore(plan.date), to: plan.date });
      show(result.data);
      setMessage(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      key: "captain",
      header: "Captain",
      value: (line) => line.userId,
      render: (line, ctx) => (
        <select aria-label={ctx.label} value={line.userId} onChange={(event) => setLine(line.key, "userId", event.target.value)}>
          <option value="">Pick a captain</option>
          {(plan ? plan.captains : []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "kind",
      header: "Has",
      value: (line) => line.kind,
      render: (line, ctx) => (
        <select aria-label={ctx.label} value={line.kind} onChange={(event) => setLine(line.key, "kind", event.target.value)}>
          {KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "target",
      header: "Which",
      value: (line) => line.targetId,
      render: (line, ctx) => (
        <select aria-label={ctx.label} value={line.targetId} onChange={(event) => setLine(line.key, "targetId", event.target.value)}>
          <option value="">Pick one</option>
          {targets[line.kind].map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "remove",
      header: "",
      label: "Remove",
      type: "actions",
      render: (line) => (
        <button
          type="button"
          className="link-button danger"
          onClick={() => setLines((all) => all.filter((one) => one.key !== line.key))}
        >
          Remove
        </button>
      ),
    },
  ];

  const readColumns = [
    { key: "captain", header: "Captain", value: (row) => row.userName, mobile: "title" },
    { key: "kind", header: "Has", value: (row) => (KINDS.find((kind) => kind.value === row.kind) || {}).label, mobile: "subtitle" },
    { key: "target", header: "Which", value: (row) => row.label, mobile: "show" },
  ];

  return (
    <Modal
      title={plan ? `Captain sections · ${dayMonth(plan.date)}` : "Captain sections"}
      description="Who looks after which floor, section or table today. Captains see My tables first; calls from their tables come to them first."
      icon="users"
      onClose={onClose}
      width={760}
    >
      {!plan && !error && <Loading label="Reading today's plan…" />}
      {plan && (
        <form className="stack" onSubmit={save}>
          {message && (
            <p className="alert alert-success" role="status">
              {message}
            </p>
          )}
          {canManage ? (
            <>
              {lines.length === 0 && (
                <p className="muted small">
                  No plan yet for {dayMonth(plan.date)}. Add a line per captain, or copy yesterday's plan.
                </p>
              )}
              {lines.length > 0 && (
                <DataGrid variant="editor" caption="Captain sections" columns={columns} rows={lines} rowKey={(line) => line.key} />
              )}
              <div className="cap-actions">
                <button type="button" className="button button-secondary" onClick={() => setLines((all) => [...all, lineOf(null)])}>
                  <Icon name="plus" size={15} /> Add a line
                </button>
                <button type="button" className="button button-secondary" onClick={copyYesterday} disabled={saving || lines.length > 0}>
                  <Icon name="copy" size={15} /> Copy yesterday's plan
                </button>
              </div>
            </>
          ) : (
            <DataGrid
              id="captain-sections"
              variant="compact"
              caption="Captain sections"
              columns={readColumns}
              rows={plan.assignments}
              rowKey={(row) => row.id}
              empty="No captain plan for today"
              emptyIcon="users"
              pageSize={false}
            />
          )}

          <ErrorMessage message={error} />

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            {canManage && (
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save plan"}
              </button>
            )}
          </div>
        </form>
      )}
      {!plan && error && <ErrorMessage message={error} />}
    </Modal>
  );
}
