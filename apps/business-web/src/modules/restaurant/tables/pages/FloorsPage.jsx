import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatusBadge from "../../../../components/StatusBadge";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  createArea,
  createFloor,
  deleteArea,
  deleteFloor,
  getFloorSettings,
  listAreas,
  listFloors,
  updateArea,
  updateFloor,
  updateFloorSettings,
} from "../services/table.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { count } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import { useLocation } from "react-router-dom";
import "../styles/tables.css";

const EMPTY_FLOOR = { name: "", sortOrder: 0, status: "active" };
const EMPTY_AREA = { floorId: "", name: "", sortOrder: 0, status: "active" };

export default function FloorsPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("tables.manage");
  // The cleaning time is one rule for every outlet's floor: it is set for
  // the whole restaurant, not from inside one outlet (the server refuses it
  // there too). Floors and areas that hold another outlet's tables, or tables
  // every outlet shares, are refused the same way, with the reason.
  const workingOutlet = user.outletId || outletStorage.get() || null;
  const canSetTurnover = canManage && !workingOutlet;

  const [floors, setFloors] = useState([]);
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [floorForm, setFloorForm] = useState(null);
  const [areaForm, setAreaForm] = useState(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null); // { kind: "floor" | "area", row }

  // How long a settled table shows as Cleaning. Kept as typed text while it
  // is being edited, so clearing the box to type a new number works.
  const [cleaningMinutes, setCleaningMinutes] = useState("");
  const [savedMinutes, setSavedMinutes] = useState(null);
  const [turnoverError, setTurnoverError] = useState("");
  const [savingTurnover, setSavingTurnover] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([listFloors(), listAreas()])
        .then(([floorRows, areaRows]) => {
          setFloors(floorRows);
          setAreas(areaRows);
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();

    getFloorSettings()
      .then((settings) => {
        setSavedMinutes(settings.cleaningMinutes);
        setCleaningMinutes(String(settings.cleaningMinutes));
      })
      .catch((err) => setTurnoverError(getErrorMessage(err)));
  }, [load]);

  // The floor plan's "Change" link lands on the turnover setting. The page
  // renders it only once floors have loaded, and a client-side navigation
  // never scrolls to a #hash by itself, so it is done here.
  const { hash } = useLocation();

  useEffect(() => {
    if (!loading && hash === "#turnover") {
      document.getElementById("turnover")?.scrollIntoView({ block: "start" });
    }
  }, [loading, hash]);

  const saveTurnover = async (event) => {
    event.preventDefault();
    setTurnoverError("");
    setSavingTurnover(true);

    try {
      const saved = await updateFloorSettings({ cleaningMinutes: Number(cleaningMinutes) });
      setSavedMinutes(saved.cleaningMinutes);
      setCleaningMinutes(String(saved.cleaningMinutes));
      setSuccess(
        saved.cleaningMinutes > 0
          ? `Settled tables now show as Cleaning for ${saved.cleaningMinutes} min`
          : "Cleaning hold switched off: settled tables are free straight away"
      );
    } catch (err) {
      setTurnoverError(getErrorMessage(err));
    } finally {
      setSavingTurnover(false);
    }
  };

  const saveFloor = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = { ...floorForm.values, sortOrder: Number(floorForm.values.sortOrder) };

    try {
      if (floorForm.id) {
        await updateFloor(floorForm.id, payload);
        setSuccess("Floor updated");
      } else {
        await createFloor(payload);
        setSuccess("Floor created");
      }

      setFloorForm(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveArea = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      ...areaForm.values,
      floorId: Number(areaForm.values.floorId),
      sortOrder: Number(areaForm.values.sortOrder),
    };

    try {
      if (areaForm.id) {
        await updateArea(areaForm.id, payload);
        setSuccess("Area updated");
      } else {
        await createArea(payload);
        setSuccess("Area created");
      }

      setAreaForm(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      if (deleting.kind === "floor") {
        await deleteFloor(deleting.row.id);
      } else {
        await deleteArea(deleting.row.id);
      }

      setDeleting(null);
      setSuccess("Deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Loading />;
  }

  const openNewFloor = () => {
    setFloorForm({ id: null, values: { ...EMPTY_FLOOR, sortOrder: floors.length + 1 } });
    setFormError("");
  };

  const openEditFloor = (floor) => {
    setFloorForm({
      id: floor.id,
      values: { name: floor.name, sortOrder: floor.sortOrder, status: floor.status },
    });
    setFormError("");
  };

  const openNewArea = () => {
    setAreaForm({
      id: null,
      values: { ...EMPTY_AREA, floorId: floors[0] ? String(floors[0].id) : "" },
    });
    setFormError("");
  };

  const openEditArea = (area) => {
    setAreaForm({
      id: area.id,
      values: {
        floorId: String(area.floorId),
        name: area.name,
        sortOrder: area.sortOrder,
        status: area.status,
      },
    });
    setFormError("");
  };

  const openFloors = floors.filter((floor) => floor.status === "active").length;
  const openAreas = areas.filter((area) => area.status === "active").length;
  const placedTables = floors.reduce((sum, floor) => sum + Number(floor.tableCount || 0), 0);

  const addFloorButton = canManage && (
    <button type="button" className="button button-sm" onClick={openNewFloor}>
      <Icon name="plus" size={15} /> Add floor
    </button>
  );

  const addAreaButton = canManage && (
    <button
      type="button"
      className="button button-secondary button-sm"
      onClick={openNewArea}
      disabled={floors.length === 0}
      title={floors.length === 0 ? "Add a floor first" : undefined}
    >
      <Icon name="plus" size={15} /> Add area
    </button>
  );

  return (
    <div className="stack fp-page">
      <PageHeader
        icon="layers"
        title="Floors & areas"
        description="How the restaurant is laid out: floors, the sections inside them, and how long a table takes to turn."
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <div className="stat-grid">
        <StatTile
          icon="layers"
          tone="primary"
          label="Floors open"
          value={count(openFloors)}
          of={floors.length > openFloors ? ` of ${count(floors.length)}` : undefined}
          note={floors.length > openFloors ? `${count(floors.length - openFloors)} closed` : "all open"}
        />
        <StatTile
          icon="grid"
          tone="info"
          label="Dining areas"
          value={count(openAreas)}
          of={areas.length > openAreas ? ` of ${count(areas.length)}` : undefined}
          note={
            areas.length === 0
              ? "optional sections"
              : areas.length > openAreas
                ? `${count(areas.length - openAreas)} closed`
                : "all open"
          }
        />
        <StatTile
          icon="table"
          tone="success"
          label="Tables placed"
          value={count(placedTables)}
          note="open the floor plan"
          to="/tables"
        />
        <StatTile
          icon="timer"
          tone="warning"
          label="Cleaning hold"
          value={savedMinutes === null ? "—" : savedMinutes > 0 ? `${savedMinutes} min` : "Off"}
          note="after a bill is settled"
        />
      </div>

      <SectionCard
        icon="layers"
        title="Floors"
        description="Each floor is a block on the floor plan. The lowest number is shown first."
        actions={addFloorButton}
        flush
      >
        {floors.length === 0 ? (
          <EmptyState
            icon="layers"
            message="No floors yet"
            hint="Every table sits on a floor. Start with the one guests walk into, such as Ground Floor."
            action={addFloorButton}
          />
        ) : (
          <DataGrid
            id="floors"
            caption="Floors"
            rows={floors}
            rowKey={(floor) => floor.id}
            rowClassName={(floor) => (floor.status === "active" ? "" : "dg-tone-muted")}
            rowNoun={["floor", "floors"]}
            columns={[
              { key: "order", header: "Order", type: "number", value: (floor) => floor.sortOrder, mobile: "hide" },
              { key: "name", header: "Name", value: (floor) => floor.name, mobile: "title" },
              { key: "areas", header: "Areas", type: "number", value: (floor) => floor.areaCount, total: "sum", mobile: "show" },
              { key: "tables", header: "Tables", type: "number", value: (floor) => floor.tableCount, total: "sum", mobile: "show" },
              {
                key: "status",
                header: "Status",
                type: "status",
                value: (floor) => floor.status,
                mobile: "subtitle",
                render: (floor) => <StatusBadge status={floor.status} />,
              },
                  canManage && {
                    key: "actions",
                    header: "",
                    label: "Actions",
                    type: "actions",
                    render: (row) => (
                      <div className="row-actions">
                        <button type="button" className="chip-button" onClick={() => openEditFloor(row)}>
                          <Icon name="edit" size={14} /> Edit
                        </button>
                        <ActionMenu
                          label={`More actions for ${row.name}`}
                          items={[
                            {
                              label: "Delete",
                              icon: "trash",
                              danger: true,
                              onClick: () => setDeleting({ kind: "floor", row }),
                            },
                          ]}
                        />
                      </div>
                    ),
                  },
            ]}
          />
        )}
      </SectionCard>

      <SectionCard
        icon="grid"
        tone="info"
        title="Dining areas"
        description="Optional sections inside a floor, such as AC, Family or Terrace. Tables can also sit straight on a floor."
        actions={addAreaButton}
        flush
      >
        {areas.length === 0 ? (
          <EmptyState
            icon="grid"
            message="No areas yet"
            hint="Areas are optional. Add one when staff talk about a part of the room by name, such as the AC section."
            action={floors.length > 0 && addAreaButton}
          />
        ) : (
          <DataGrid
            id="dining-areas"
            caption="Dining areas"
            rows={areas}
            rowKey={(area) => area.id}
            rowClassName={(area) => (area.status === "active" ? "" : "dg-tone-muted")}
            rowNoun={["area", "areas"]}
            columns={[
              { key: "floor", header: "Floor", value: (area) => area.floorName, filter: "select", mobile: "subtitle" },
              { key: "name", header: "Area", value: (area) => area.name, mobile: "title" },
              { key: "tables", header: "Tables", type: "number", value: (area) => area.tableCount, total: "sum", mobile: "show" },
              {
                key: "status",
                header: "Status",
                type: "status",
                value: (area) => area.status,
                mobile: "show",
                render: (area) => <StatusBadge status={area.status} />,
              },
                  canManage && {
                    key: "actions",
                    header: "",
                    label: "Actions",
                    type: "actions",
                    render: (row) => (
                      <div className="row-actions">
                        <button type="button" className="chip-button" onClick={() => openEditArea(row)}>
                          <Icon name="edit" size={14} /> Edit
                        </button>
                        <ActionMenu
                          label={`More actions for ${row.name}`}
                          items={[
                            {
                              label: "Delete",
                              icon: "trash",
                              danger: true,
                              onClick: () => setDeleting({ kind: "area", row }),
                            },
                          ]}
                        />
                      </div>
                    ),
                  },
            ]}
          />
        )}
      </SectionCard>

      <SectionCard
        id="turnover"
        icon="timer"
        tone="warning"
        title="Table turnover"
        description="How long a settled table shows as Cleaning, so nobody seats a new party before it is cleared and laid."
      >
        <div className="fp-turnover">
          <p className="muted small fp-turnover-help">
            When a bill is settled the guests are usually still getting up. The floor plan shows the
            table as <strong>Cleaning</strong> for this long, unless someone taps{" "}
            <strong>Mark ready</strong> first. Captains, cashiers and managers can mark a table
            ready. Set 0 to switch the hold off.
          </p>

          <ErrorMessage message={turnoverError} />

          {canSetTurnover ? (
            <form className="fp-turnover-form" onSubmit={saveTurnover}>
              <label className="field">
                <span>Cleaning time (minutes)</span>
                <input
                  type="number"
                  min="0"
                  max="120"
                  step="1"
                  value={cleaningMinutes}
                  onChange={(event) => setCleaningMinutes(event.target.value)}
                  required
                />
              </label>
              <button
                type="submit"
                className="button"
                disabled={savingTurnover || cleaningMinutes === String(savedMinutes)}
              >
                {savingTurnover ? "Saving…" : "Save"}
              </button>
            </form>
          ) : (
            savedMinutes !== null && (
              <p className="fp-turnover-now">
                {savedMinutes > 0
                  ? `Settled tables show as Cleaning for ${savedMinutes} min.`
                  : "The cleaning hold is off."}
                {canManage && workingOutlet && (
                  <span className="muted small fp-turnover-whole">
                    {" "}
                    It is the same for every outlet, so it is set{" "}
                    {user.outletId ? "by the owner or a manager who works across outlets." : "with All outlets picked at the top."}
                  </span>
                )}
              </p>
            )
          )}
        </div>
      </SectionCard>

      {floorForm && (
        <Modal
          title={floorForm.id ? "Edit floor" : "Add floor"}
          description="A floor groups its tables on the floor plan."
          icon="layers"
          onClose={() => setFloorForm(null)}
        >
          <form className="form-grid" onSubmit={saveFloor}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Name *</span>
              <input
                value={floorForm.values.name}
                onChange={(event) =>
                  setFloorForm({
                    ...floorForm,
                    values: { ...floorForm.values, name: event.target.value },
                  })
                }
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span>Display order</span>
              <input
                type="number"
                min="0"
                value={floorForm.values.sortOrder}
                onChange={(event) =>
                  setFloorForm({
                    ...floorForm,
                    values: { ...floorForm.values, sortOrder: event.target.value },
                  })
                }
              />
            </label>

            <label className="field field-wide">
              <span>Status</span>
              <select
                value={floorForm.values.status}
                onChange={(event) =>
                  setFloorForm({
                    ...floorForm,
                    values: { ...floorForm.values, status: event.target.value },
                  })
                }
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <small className="muted">
                Inactive closes every table on this floor: they show as out of service and are
                never offered for seating.
              </small>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setFloorForm(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {areaForm && (
        <Modal
          title={areaForm.id ? "Edit area" : "Add area"}
          description="A named section inside a floor, such as AC or Terrace."
          icon="grid"
          onClose={() => setAreaForm(null)}
        >
          <form className="form-grid" onSubmit={saveArea}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Floor *</span>
              <select
                value={areaForm.values.floorId}
                onChange={(event) =>
                  setAreaForm({
                    ...areaForm,
                    values: { ...areaForm.values, floorId: event.target.value },
                  })
                }
                required
              >
                {floors.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Area name *</span>
              <input
                value={areaForm.values.name}
                onChange={(event) =>
                  setAreaForm({
                    ...areaForm,
                    values: { ...areaForm.values, name: event.target.value },
                  })
                }
                required
                autoFocus
                placeholder="AC Section"
              />
            </label>

            <label className="field">
              <span>Display order</span>
              <input
                type="number"
                min="0"
                value={areaForm.values.sortOrder}
                onChange={(event) =>
                  setAreaForm({
                    ...areaForm,
                    values: { ...areaForm.values, sortOrder: event.target.value },
                  })
                }
              />
            </label>

            <label className="field field-wide">
              <span>Status</span>
              <select
                value={areaForm.values.status}
                onChange={(event) =>
                  setAreaForm({
                    ...areaForm,
                    values: { ...areaForm.values, status: event.target.value },
                  })
                }
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <small className="muted">
                Inactive closes every table in this area, for example a terrace in the monsoon.
              </small>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setAreaForm(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={deleting.kind === "floor" ? "Delete floor" : "Delete area"}
          message={`Delete "${deleting.row.name}"? It must have no tables.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
