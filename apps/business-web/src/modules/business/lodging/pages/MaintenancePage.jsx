import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { TicketDialog, TicketStepDialog } from "./HouseDialogs";
import { PRIORITIES, TICKET_STATUS, atWords, dateWords } from "./lodging";
import "../styles/lodging.css";

// Maintenance: each room's tickets, the open ones first (in progress, then
// open), the most urgent first: the issue, its priority, who it is given to,
// when the work started and ended, and the out-of-order period the work needs.
// Started, done (the room back in order from tonight) or cancelled with why.
// Tasks still hold the rounds; a ticket is one room's repair.

export default function MaintenancePage() {
  const biz = useOpenBusiness();
  const [show, setShow] = useState("open");
  const list = useServerList("lodging/tickets", { gridId: "lodging-tickets", params: show === "open" ? { open: "true" } : {} });
  const [rooms, setRooms] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(null);
  const canEdit = biz.can("lodging.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/rooms/board", undefined, controller.signal).then((b) => setRooms(b.rooms)).catch(() => {});
    return () => controller.abort();
  }, [biz.id]);
  const done = (message) => { setDialog(null); toast.success(message); list.reload(); };
  const start = async (t) => {
    setBusy(t.id);
    try {
      await businessWrite(biz.id, `lodging/tickets/${t.id}/start`, {});
      done(`Ticket ${t.ticket_no}: work started.`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const many = biz.locations.length > 1;
  const priority = (value) => PRIORITIES.find((p) => p.value === value) || PRIORITIES[2];
  const columns = useMemo(() => [
    { key: "ticket_no", header: "Ticket", type: "number", value: (t) => t.ticket_no, mobile: "title", pin: true, render: (t) => <span className="mono">{t.ticket_no}</span> },
    { key: "room", header: "Room", value: (t) => t.room_no, mobile: "subtitle",
      render: (t) => <span className="bz-two-line"><span>Room {t.room_no}</span><small className="muted">{t.room_type}{many ? ` · ${t.location_name}` : ""}</small></span> },
    { key: "issue", header: "Issue", value: (t) => t.issue, mobile: "show" },
    { key: "priority", header: "Priority", value: (t) => priority(t.priority).label, render: (t) => <Badge tone={priority(t.priority).tone} label={priority(t.priority).label} />,
      filter: "select", filterOptions: PRIORITIES.map((p) => ({ value: p.label, label: p.label })) },
    { key: "status", header: "Status", type: "status", value: (t) => TICKET_STATUS[t.status].label, mobile: "show",
      render: (t) => <Badge tone={TICKET_STATUS[t.status].tone} label={TICKET_STATUS[t.status].label} /> },
    { key: "assigned", header: "Given to", value: (t) => t.assigned_name || "" },
    { key: "out_of_order", header: "Out of order", value: (t) => t.out_of_order_from || "",
      render: (t) => (!t.out_of_order_id ? "" : t.out_of_order_withdrawn ? <span className="muted">withdrawn</span>
        : `${dateWords(t.out_of_order_from)}${t.out_of_order_to ? ` to ${dateWords(t.out_of_order_to)}` : " until done"}`) },
    { key: "started", header: "Started", type: "datetime", value: (t) => t.started_at || "", render: (t) => (t.started_at ? atWords(t.started_at, biz) : "") },
    { key: "finished", header: "Ended", type: "datetime", value: (t) => t.finished_at || "", render: (t) => (t.finished_at ? atWords(t.finished_at, biz) : "") },
    { key: "outcome", header: "Done, or why cancelled", value: (t) => t.outcome || "", defaultHidden: true },
    { key: "created", header: "Opened", type: "datetime", value: (t) => t.created_at, render: (t) => `${atWords(t.created_at, biz)} · ${t.created_by_name}`, defaultHidden: true },
    canEdit && { key: "actions", header: "", type: "actions",
      render: (t) => (["open", "in_progress"].includes(t.status) ? (
        <span className="ldg-row-actions">
          {t.status === "open" && <button type="button" className="link-button" disabled={busy === t.id} onClick={() => start(t)}>Start</button>}
          <button type="button" className="link-button" onClick={() => setDialog({ kind: "done", ticket: t })}>Done</button>
          <button type="button" className="link-button" onClick={() => setDialog({ kind: "cancel", ticket: t })}>Cancel</button>
        </span>
      ) : null) },
  ].filter(Boolean), [biz, many, canEdit, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <BusinessHeader icon="settings" title="Maintenance" description="Each room's repairs, the most urgent first. A ticket can take the room out of order while the work is done; marked done, the room is back in order from tonight."
        primary={canEdit && <button type="button" className="button" onClick={() => setDialog({ kind: "new" })}><Icon name="plus" size={16} /> Open a ticket</button>} />
      <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Ticket, room, issue or who it is given to" }} caption="Maintenance tickets" columns={columns}
        rowNoun={["ticket", "tickets"]} toolbar={<Segmented label="Show" options={[{ value: "open", label: "Open" }, { value: "all", label: "Every ticket" }]} value={show} onChange={setShow} />}
        rowClassName={(t) => (t.priority === "urgent" && ["open", "in_progress"].includes(t.status) ? "dg-tone-danger" : ["done", "cancelled"].includes(t.status) ? "dg-tone-muted" : "")}
        exportName={`${biz.business.code}-maintenance`} empty={show === "open" ? "No open tickets" : "No tickets yet"} emptyIcon="check" />
      {dialog?.kind === "new" && <TicketDialog rooms={rooms} onClose={() => setDialog(null)} onSaved={(r) => done(`Ticket ${r.ticket.ticket_no} opened.`)} />}
      {["done", "cancel"].includes(dialog?.kind) && <TicketStepDialog ticket={dialog.ticket} step={dialog.kind} onClose={() => setDialog(null)}
        onSaved={() => done(dialog.kind === "done" ? `Ticket ${dialog.ticket.ticket_no} done.` : `Ticket ${dialog.ticket.ticket_no} cancelled.`)} />}
    </div>
  );
}
