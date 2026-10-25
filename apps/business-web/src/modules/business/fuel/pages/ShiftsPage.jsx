import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { OutletPicker, SettlementBadge } from "./FuelParts";
import { SHIFT_STATES, atWords, dueWords, firstOutlet, reading, stampingTone } from "./fuel";
import "../styles/fuel.css";

// Shift & readings: the day's board at an outlet. The prices in force; each
// dispensing unit's nozzles, free or on whose shift, with the unit's Weights
// & Measures stamping; the shifts open (each closed on its own page, with its
// readings and the attendant's takings) and those closed today with the
// attendant's short or excess; and every shift by date. A shift is opened from
// the nozzles' totalisers as they last read. An attendant sees their own
// shifts only.

export default function ShiftsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [outlet, setOutlet] = useState(() => firstOutlet(biz));
  const [view, setView] = useState("today");
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/shifts/day", outlet ? { locationId: outlet } : undefined, controller.signal)
      .then((b) => { setBoard(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, outlet, version]);
  const canOpen = biz.can("fuel.create");
  // ?open=1 (the Overview's "Open a shift") opens the dialog once the board is in; closing it clears that.
  const asked = params.get("open") === "1" && canOpen;
  const closeDialog = () => { setOpening(false); if (asked) setParams((p) => { const next = new URLSearchParams(p); next.delete("open"); return next; }, { replace: true }); };
  const free = (board?.nozzles || []).filter((n) => !n.open_shift_id && n.unit_status === "in_use");

  return (
    <div className="stack">
      <BusinessHeader icon="timer" title="Shift & readings"
        description="Each attendant's shift: the nozzles they run, from each totaliser's reading, and at the close the readings, the 5-litre test, the credit slips and the money handed in. The close bills the fuel sold; a closed shift is reopened only by a manager, before the next shift starts."
        primary={canOpen && <button type="button" className="button" disabled={!board || !free.length} onClick={() => setOpening(true)}><Icon name="plus" size={16} /> Open a shift</button>} />
      <div className="fuel-toolbar">
        <OutletPicker biz={biz} value={outlet} onChange={setOutlet} />
        <Segmented label="Show" options={[{ value: "today", label: "Today" }, { value: "all", label: "Every shift" }]} value={view} onChange={setView} />
      </div>
      <ErrorMessage message={error} />
      {view === "all" ? <AllShifts biz={biz} outlet={outlet} onOpen={(s) => navigate(biz.path(`fuel-shifts/${s.id}`))} />
        : !board ? (!error && <Loading />) : <Board biz={biz} board={board} onOpen={(s) => navigate(biz.path(`fuel-shifts/${s.id}`))} />}
      {(opening || asked) && board && <OpenShiftDialog biz={biz} board={board} free={free} onClose={closeDialog}
        onOpened={(shift) => { closeDialog(); setVersion((n) => n + 1); navigate(biz.path(`fuel-shifts/${shift.id}`)); }} />}
    </div>
  );
}

function Board({ biz, board, onOpen }) {
  const units = useMemo(() => {
    const list = [];
    for (const n of board.nozzles) {
      let unit = list.find((u) => String(u.id) === String(n.dispenser_id));
      if (!unit) { unit = { id: n.dispenser_id, unitNo: n.unit_no, status: n.unit_status, due: n.stamping_due, days: n.days_to_due, nozzles: [] }; list.push(unit); }
      unit.nozzles.push(n);
    }
    return list;
  }, [board.nozzles]);
  const unpriced = board.prices.filter((p) => p.price === null);
  return (
    <>
      <SectionCard icon="tag" title="Prices in force" description={`At ${board.location.name}, a litre (CNG a kg), including state VAT. A shift keeps the prices it opened at.`}
        actions={biz.can("settings.view") && <Link className="button button-secondary button-sm" to={biz.path("fuel-pumps")}>Pumps & nozzles</Link>}>
        {board.prices.length ? (
          <ul className="fuel-prices" aria-label="Prices in force">
            {board.prices.map((p) => (
              <li key={p.product_id} className={p.price === null ? "is-missing" : ""}>
                <span>{p.name}</span>
                <strong className="mono">{p.price === null ? "No price" : biz.exact(p.price)}</strong>
                {p.next_price !== null && <small className="muted">{biz.exact(p.next_price)} from {atWords(p.next_from, biz)}</small>}
              </li>
            ))}
          </ul>
        ) : <p className="muted">No fuels yet: add them under Settings › Pumps & nozzles.</p>}
        {unpriced.length > 0 && <p className="fuel-note fuel-warn">{unpriced.map((p) => p.name).join(", ")} {unpriced.length === 1 ? "has" : "have"} no price here: a shift opens on {unpriced.length === 1 ? "its" : "their"} nozzles once the price is set.</p>}
      </SectionCard>

      <SectionCard icon="fire" title="Nozzles" description="Each nozzle's totaliser as its last shift closed it. A nozzle is on one open shift at a time.">
        {units.length ? (
          <div className="fuel-units">
            {units.map((u) => (
              <section key={u.id} className={`fuel-unit ${u.status !== "in_use" ? "is-off" : ""}`} aria-label={`Dispensing unit ${u.unitNo}`}>
                <h3 className="fuel-unit-head">
                  <span>{u.unitNo}</span>
                  {u.status !== "in_use" ? <Badge tone="warning" label="Suspended" />
                    : <Badge tone={stampingTone(u.days, board.settings.stampingWarnDays)} label={`Stamping ${dueWords(u.days)}`} />}
                </h3>
                <ul className="fuel-nozzle-list">
                  {u.nozzles.map((n) => (
                    <li key={n.id} className={`fuel-nozzle ${n.open_shift_id ? "is-busy" : ""}`}>
                      <span className="fuel-nozzle-top"><strong>Nozzle {n.nozzle_no}</strong><span className="small">{n.product_name}{n.tank_no ? ` · tank ${n.tank_no}` : ""}</span></span>
                      <span className="mono">{reading(n.reading)}</span>
                      {n.open_shift_id
                        ? <button type="button" className="link-button small" onClick={() => onOpen({ id: n.open_shift_id })}>On {n.open_shift_no} · {n.open_attendant}</button>
                        : <span className="small muted">Free</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : <p className="muted">No nozzles at this outlet yet: add the dispensing units under Settings › Pumps & nozzles.</p>}
      </SectionCard>

      <SectionCard icon="timer" title="Open shifts" description={board.open.length ? `${board.open.length} open` : undefined}>
        {board.open.length ? (
          <ul className="fuel-shift-cards">
            {board.open.map((s) => (
              <li key={s.id} className="fuel-shift-card">
                <span className="fuel-shift-top"><strong>{s.attendant_name}</strong><span className="mono small muted">{s.shift_no}</span></span>
                <span className="small">Opened {atWords(s.opened_at, biz)}</span>
                <span className="small">{s.nozzles.map((n) => `Nozzle ${n.nozzle_no} (${n.product_name}) from ${reading(n.opening)}`).join(" · ")}</span>
                <Link className="button button-sm" to={biz.path(`fuel-shifts/${s.id}`)}>{biz.can("fuel.create") ? "Close the shift" : "Open"}</Link>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No shift is open at this outlet.</p>}
      </SectionCard>

      <SectionCard flush icon="check" title="Closed today">
        <DataGrid variant="compact" id="fuel-shifts-today" caption="Shifts closed today" rows={board.closed} rowKey={(s) => s.id} currency={biz.symbol}
          rowNoun={["shift", "shifts"]} onRowClick={onOpen}
          columns={[
            { key: "shift_no", header: "Shift", value: (s) => s.shift_no, className: "mono", mobile: "title", pin: true },
            { key: "attendant", header: "Attendant", value: (s) => s.attendant_name, mobile: "subtitle" },
            { key: "closed_at", header: "Closed", type: "datetime", value: (s) => s.closed_at, render: (s) => atWords(s.closed_at, biz) },
            { key: "sold", header: "Sold", value: (s) => s.sold || "" },
            { key: "expected", header: "Expected", type: "money", exact: true, value: (s) => (s.expected === null ? null : Number(s.expected)), total: "sum" },
            { key: "difference", header: "Short / excess", value: (s) => (s.difference === null ? "" : Number(s.difference)), mobile: "show",
              render: (s) => (s.difference === null ? <span className="muted">—</span> : <SettlementBadge biz={biz} difference={s.difference} />) },
            { key: "document_no", header: "Walk-in bill", value: (s) => s.document_no || "", className: "mono", defaultHidden: true },
          ]}
          empty="No shift closed today" emptyHint="A shift closes on its own page, with its readings and takings." emptyIcon="timer" />
      </SectionCard>
    </>
  );
}

function AllShifts({ biz, outlet, onOpen }) {
  const list = useServerList("fuel/shifts", { gridId: "fuel-shifts", period: true, params: outlet ? { location: outlet } : {} });
  const columns = useMemo(() => [
    { key: "shift_no", header: "Shift", value: (s) => s.shift_no, className: "mono", mobile: "title", pin: true },
    { key: "attendant", header: "Attendant", value: (s) => s.attendant_name, mobile: "subtitle" },
    { key: "opened_at", header: "Opened", type: "datetime", value: (s) => s.opened_at, render: (s) => atWords(s.opened_at, biz) },
    { key: "closed_at", header: "Closed", type: "datetime", value: (s) => s.closed_at, render: (s) => (s.closed_at ? atWords(s.closed_at, biz) : "—") },
    { key: "nozzles", header: "Nozzles", value: (s) => s.nozzle_list || "" },
    { key: "sold", header: "Sold", value: (s) => s.sold || "" },
    { key: "status", header: "Status", type: "status", value: (s) => SHIFT_STATES[s.status]?.label || s.status, mobile: "show",
      render: (s) => <span className="bz-two-line"><Badge tone={SHIFT_STATES[s.status]?.tone} label={SHIFT_STATES[s.status]?.label || s.status} />{s.reopened > 0 && <small className="muted">reopened {s.reopened === 1 ? "once" : `${s.reopened} times`}</small>}</span>,
      filter: "select", filterOptions: Object.values(SHIFT_STATES).map((x) => ({ value: x.label, label: x.label })) },
    { key: "expected", header: "Expected", type: "money", exact: true, value: (s) => (s.expected === null ? null : Number(s.expected)), total: "sum" },
    { key: "difference", header: "Short / excess", value: (s) => (s.difference === null ? "" : Number(s.difference)),
      render: (s) => (s.difference === null ? <span className="muted">—</span> : <SettlementBadge biz={biz} difference={s.difference} />) },
    { key: "document_no", header: "Walk-in bill", value: (s) => s.document_no || "", className: "mono", defaultHidden: true },
  ], [biz]);
  return (
    <SectionCard flush icon="list" title="Every shift">
      <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Shift, attendant, nozzle, fuel or bill" }} caption="Shifts" columns={columns}
        currency={biz.symbol} rowNoun={["shift", "shifts"]} onRowClick={onOpen} toolbar={<PeriodFilter list={list} />}
        rowClassName={(s) => (s.status === "open" ? "dg-tone-info" : Number(s.difference) < 0 ? "dg-tone-danger" : "")}
        exportName={biz.can("fuel.export") ? `${biz.business.code}-shifts` : undefined}
        empty="No shifts in these dates" emptyHint="Pick other dates." emptyIcon="timer" />
    </SectionCard>
  );
}

// A shift opened: the attendant, the nozzles they run (each from its totaliser
// as it last read, checked against the meter), and when the readings were taken.
function OpenShiftDialog({ biz, board, free, onClose, onOpened }) {
  const { user } = useAuth();
  const [key] = useState(newKey);
  const [attendants, setAttendants] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [attendantId, setAttendantId] = useState("");
  const [openedAt, setOpenedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [chosen, setChosen] = useState({});
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/attendants", undefined, controller.signal)
      .then((list) => {
        setAttendants(list);
        const here = list.filter((a) => !a.location_id || String(a.location_id) === String(board.location.id));
        if (here.length === 1) setAttendantId(String(here[0].id));
        else if (here.some((a) => String(a.id) === String(user?.id))) setAttendantId(String(user.id));
      })
      .catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, board.location.id, user?.id]);
  const toggle = (n) => setChosen((c) => {
    const next = { ...c };
    if (next[n.id] !== undefined) delete next[n.id];
    else next[n.id] = String(Number(n.reading).toFixed(3));
    return next;
  });
  const here = (attendants || []).filter((a) => !a.location_id || String(a.location_id) === String(board.location.id));
  const count = free.filter((n) => chosen[n.id] !== undefined).length;
  const submit = () => {
    const nozzles = free.filter((n) => chosen[n.id] !== undefined).map((n) => ({ nozzleId: n.id, opening: chosen[n.id] }));
    if (!nozzles.length) throw new Error("Choose the nozzles the attendant runs");
    return businessWrite(biz.id, "fuel/shifts", { requestKey: key, locationId: board.location.id, attendantId: attendantId || undefined,
      ...(openedAt ? { openedAt } : {}), nozzles, notes: notes.trim() || undefined });
  };
  return (
    <FormDialog title="Open a shift" icon="timer" width={720} onClose={onClose} onSaved={onOpened} onSubmit={submit} submitLabel="Open the shift"
      successMessage={(s) => `Shift ${s.shift_no} opened for ${s.attendant_name}.`}
      description={`At ${board.location.name}. Each nozzle opens from its totaliser as its last shift closed it: check it against the meter. A meter replaced or reset is recorded by a manager first.`}>
      <FormError message={loadError} />
      <Field label="Attendant" wide>
        <select required value={attendantId} onChange={(e) => setAttendantId(e.target.value)} disabled={!attendants}>
          {here.length !== 1 && <option value="">Choose the attendant</option>}
          {here.map((a) => <option key={a.id} value={String(a.id)}>{a.name}{a.role_name ? ` (${a.role_name})` : ""}</option>)}
        </select>
      </Field>
      <fieldset className="field-wide fuel-fieldset">
        <legend>Nozzles</legend>
        {free.length ? free.map((n) => (
          <div key={n.id} className="fuel-pick-row">
            <label className="checkbox bz-check"><input type="checkbox" checked={chosen[n.id] !== undefined} onChange={() => toggle(n)} /> Nozzle {n.nozzle_no} · {n.product_name}{n.tank_no ? ` · tank ${n.tank_no}` : ""} · {n.unit_no}</label>
            {chosen[n.id] !== undefined && (
              <Field label={`Nozzle ${n.nozzle_no}: totaliser now`}>
                <input inputMode="decimal" className="mono" required value={chosen[n.id]} onChange={(e) => setChosen((c) => ({ ...c, [n.id]: e.target.value }))} />
              </Field>
            )}
          </div>
        )) : <p className="muted">Every nozzle in use is on an open shift.</p>}
      </fieldset>
      <Field label="Readings taken at (optional)" hint="Left empty: now. Type the time when the readings were taken earlier.">
        <input type="datetime-local" value={openedAt} onChange={(e) => setOpenedAt(e.target.value)} />
      </Field>
      <Field label="Notes (optional)" wide><input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {count > 0 && <p className="fuel-note field-wide">{count} {count === 1 ? "nozzle" : "nozzles"}, at the prices in force when the readings were taken.</p>}
    </FormDialog>
  );
}
