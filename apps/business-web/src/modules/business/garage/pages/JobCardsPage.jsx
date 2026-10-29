import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { duration } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import JobCardDialog from "./JobCardDialog";
import { MechanicBoard } from "./MechanicJobs";
import { BOARD, STATUSES, atWords, km, mechanicOnly } from "./garage";
import "../styles/garage.css";

// Job cards: the board of open job cards by status (received, estimate sent,
// approved, in progress, waiting for parts, ready), each card with its plate,
// customer, promised time, mechanics and how much of the work is done; every
// job card by date for the desk; and opening a new one. A mechanic sees the
// job cards assigned to them, phone first (MechanicJobs.jsx).

export default function JobCardsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const desk = biz.can("garage.view");
  const canOpen = biz.can("garage.create");
  const [view, setView] = useState("board");
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [opening, setOpening] = useState(() => (params.get("new") === "1" && canOpen ? { vehicleId: params.get("vehicle") || null } : null));
  useEffect(() => {
    if (params.get("new")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); next.delete("vehicle"); return next; }, { replace: true });
  }, [params, setParams]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/job-cards/board", undefined, controller.signal)
      .then((b) => { setBoard(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={desk ? "Job cards" : "My job cards"}
        description={desk ? "Every vehicle in the workshop, by where its job stands. The estimate goes to the owner for approval; parts leave stock when the job is billed."
          : "The job cards you are working on: record the work done and the parts you used, and move each job along."}
        primary={canOpen && <button type="button" className="button" onClick={() => setOpening({})}><Icon name="plus" size={16} /> Open a job card</button>} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="clipboard" title={view === "board" ? "In the workshop" : "All job cards"}
        description={view === "board" && board ? `${board.counts.open} open${board.counts.overdue ? ` · ${board.counts.overdue} past the promised time` : ""}` : undefined}
        actions={desk && <Segmented label="Show" options={[{ value: "board", label: "Board" }, { value: "all", label: "All job cards by date" }]} value={view} onChange={setView} />}>
        {view === "board" ? (board ? (mechanicOnly(biz) ? <MechanicBoard biz={biz} board={board} onOpen={(j) => navigate(biz.path(`job-cards/${j.id}`))} />
          : <Board biz={biz} board={board} onOpen={(j) => navigate(biz.path(`job-cards/${j.id}`))} />) : !error && <Loading />)
          : <AllJobCards biz={biz} onOpen={(j) => navigate(biz.path(`job-cards/${j.id}`))} />}
      </SectionCard>
      {opening && <JobCardDialog vehicleId={opening.vehicleId || null} onClose={() => setOpening(null)}
        onSaved={(j) => { setOpening(null); setVersion((n) => n + 1); toast.success(`Job card ${j.job_no} opened.`); navigate(biz.path(`job-cards/${j.id}`)); }} />}
    </div>
  );
}

function Board({ biz, board, onOpen }) {
  const money = biz.can("sales.view");
  return (
    <div className="gar-board" data-motion-skip>
      {BOARD.map((status) => {
        const cards = board.items.filter((j) => j.status === status);
        return (
          <section key={status} className={`gar-col gar-col-${status}`} aria-label={STATUSES[status].label}>
            <h2 className="gar-col-head">{STATUSES[status].label} <span>{cards.length}</span></h2>
            <ul className="gar-col-list">
              {cards.map((j) => (
                <li key={j.id} className={`gar-card ${j.overdue ? "is-late" : ""}`}>
                  <button type="button" className="gar-card-open" onClick={() => onOpen(j)}>
                    <span className="gar-plate">{j.registration_no}</span>
                    <span className="small">{j.vehicle_name}</span>
                    <span className="muted small">{j.customer_name} · {j.job_no}</span>
                    <span className="gar-card-meta">
                      {j.promised_at && <span className={j.overdue ? "is-late" : ""}><Icon name="clock" size={12} /> {atWords(j.promised_at)}{j.overdue ? " · late" : ""}</span>}
                      {j.status_since && <span>for {duration(j.status_since)}</span>}
                      {j.mechanics && <span><Icon name="user" size={12} /> {j.mechanics}</span>}
                      {j.work.lines > 0 && <span>{j.work.done} of {j.work.lines} done</span>}
                      {j.claim_mode && <span>claim: {j.insurer_name}</span>}
                      {money && Number(j.total) > 0 && <span>{biz.exact(j.total)}</span>}
                    </span>
                  </button>
                </li>
              ))}
              {!cards.length && <li className="gar-empty">Nothing here</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AllJobCards({ biz, onOpen }) {
  const list = useServerList("garage/job-cards", { gridId: "garage-job-cards", period: true });
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  const columns = useMemo(() => [
    { key: "job_no", header: "Job card", value: (j) => j.job_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Opened", type: "datetime", value: (j) => j.created_at },
    { key: "vehicle", header: "Vehicle", value: (j) => `${j.registration_no} ${j.vehicle_name}`, mobile: "subtitle",
      render: (j) => <span className="bz-two-line"><span className="gar-plate">{j.registration_no}</span><small className="muted">{j.vehicle_name}</small></span> },
    { key: "customer", header: "Customer", value: (j) => `${j.customer_name} ${j.customer_phone || ""}`,
      render: (j) => <span className="bz-two-line"><span>{j.customer_name}</span>{j.customer_phone && <small className="muted">{j.customer_phone}</small>}</span> },
    { key: "status", header: "Status", type: "status", value: (j) => STATUSES[j.status]?.label || j.status, mobile: "show",
      render: (j) => <Badge tone={STATUSES[j.status]?.tone} label={STATUSES[j.status]?.label || j.status} />,
      filter: "select", filterOptions: Object.values(STATUSES).map((s) => ({ value: s.label, label: s.label })) },
    { key: "odometer_in", header: "Reading in", type: "number", value: (j) => j.odometer_in, render: (j) => km(j.odometer_in), defaultHidden: true },
    { key: "mechanics", header: "Mechanics", value: (j) => j.mechanics || "" },
    { key: "claim", header: "Claim", value: (j) => (j.claim_mode ? `${j.insurer_name} ${j.claim_no || ""}` : ""),
      render: (j) => (j.claim_mode ? <span className="bz-two-line"><span>{j.insurer_name}</span><small className="muted">{j.claim_mode}{j.claim_no ? ` · ${j.claim_no}` : ""}</small></span> : "—") },
    money && { key: "total", header: "Total", type: "money", exact: true, value: (j) => (j.total === null ? null : Number(j.total)), total: "sum" },
    { key: "bills", header: "Bills", value: (j) => [j.document_no, j.insurer_document_no].filter(Boolean).join(" "),
      render: (j) => (j.document_no || j.insurer_document_no ? <span className="bz-two-line"><span className="mono">{j.document_no || "—"}</span>{j.insurer_document_no && <small className="muted mono">insurer {j.insurer_document_no}</small>}</span> : "—") },
    { key: "location", header: "Workshop", value: (j) => j.location_name, defaultHidden: !many },
  ].filter(Boolean), [money, many]);
  return (
    <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Job card, plate, customer, phone, bill or claim" }} caption="Job cards" columns={columns}
      currency={biz.symbol} rowNoun={["job card", "job cards"]} onRowClick={onOpen} toolbar={<PeriodFilter list={list} />}
      rowClassName={(j) => (j.overdue ? "dg-tone-danger" : j.status === "ready" ? "dg-tone-success" : ["delivered", "cancelled"].includes(j.status) ? "dg-tone-muted" : "")}
      exportName={biz.can("sales.export") ? `${biz.business.code}-job-cards` : undefined}
      empty="No job cards in these dates" emptyHint="Pick other dates." emptyIcon="clipboard" />
  );
}
