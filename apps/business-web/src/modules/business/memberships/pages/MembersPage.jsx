import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import MembershipDialog from "./MembershipDialog";
import { BringInDialog } from "./MemberExtras";
import { dayWords, endWords, statusOf } from "./memberships";
import "../../fashion/styles/business-fashion-electronics.css";
import "../styles/memberships.css";

// Members & plans: every member with their current membership (running
// first: a plan by time before a pack, the one ending first), its status
// today, its last day or the sessions left, what they owe and their last
// check-in; the day's picture above. A member opens their page; a membership
// is sold from here or from the member's page.

const CHIPS = [["", "All"], ["active", "Active"], ["frozen", "Frozen"], ["upcoming", "Not started"], ["expired", "Over"]];

export default function MembersPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const list = useServerList("member-plans/members", { gridId: "member-members", params: status ? { status } : {} });
  const [counts, setCounts] = useState(null);
  const canSell = biz.can("member_plans.create") && biz.can("sales.create");
  const [selling, setSelling] = useState(() => params.get("new") === "1" && canSell);
  const [bringing, setBringing] = useState(false);
  useEffect(() => {
    if (params.get("new")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); return next; }, { replace: true });
  }, [params, setParams]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "member-plans/counts", undefined, controller.signal).then(setCounts).catch(() => setCounts(null));
    return () => controller.abort();
  }, [biz.id, list.data]);
  const money = biz.can("sales.view");
  const columns = useMemo(() => [
    { key: "name", header: "Member", value: (r) => `${r.name} ${r.member_code || ""}`, mobile: "title", pin: true,
      render: (r) => <span className="bz-two-line"><span>{r.name}</span><small className="muted mono">{r.member_code}</small></span> },
    { key: "phone", header: "Phone", value: (r) => r.phone || "", mobile: "subtitle" },
    { key: "plan_name", header: "Membership", value: (r) => r.plan_name || "",
      render: (r) => (r.plan_name ? <span className="bz-two-line"><span>{r.plan_name}</span><small className="muted mono">{r.membership_no}</small></span> : <span className="muted">None</span>) },
    { key: "status", header: "Status", value: (r) => (r.status ? statusOf(r).label : ""), mobile: "show",
      render: (r) => (r.status ? <Badge tone={statusOf(r).tone} label={statusOf(r).label} /> : <span className="muted">—</span>) },
    { key: "end_on", header: "Last day", type: "date", value: (r) => r.end_on,
      render: (r) => (r.end_on ? <span className="bz-two-line"><span className={Number(r.days_left) < 0 ? "bz-minus" : ""}>{dayWords(r.end_on)}</span><small className="muted">{endWords(r)}</small></span>
        : r.sessions_total ? <span className="muted">No end date</span> : <span className="muted">—</span>) },
    { key: "sessions_left", header: "Sessions left", type: "number", value: (r) => (r.sessions_total ? Number(r.sessions_left) : null),
      render: (r) => (r.sessions_total ? `${r.sessions_left} of ${r.sessions_total}` : <span className="muted">—</span>) },
    money && { key: "dues", header: "Dues", type: "money", exact: true, value: (r) => Math.max(0, Number(r.dues || 0)),
      render: (r) => (Number(r.dues) > 0 ? <span className="bz-minus">{biz.exact(r.dues)}</span> : <span className="muted">—</span>) },
    { key: "last_checkin_at", header: "Last check-in", type: "datetime", value: (r) => r.last_checkin_at,
      render: (r) => (r.last_checkin_at ? dateTime(r.last_checkin_at) : <span className="muted">Never</span>) },
    { key: "running", header: "Running", type: "number", value: (r) => r.running, defaultHidden: true },
  ].filter(Boolean), [biz, money]);
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Members & plans"
        description="Every member with their current membership, its status today and its last day or sessions left. A member opens their page: renew, upgrade, freeze, pass on or cancel there."
        primary={canSell && <button type="button" className="button" onClick={() => setSelling(true)}><Icon name="plus" size={16} /> Sell a membership</button>}
        secondary={biz.can("member_plans.edit") && <button type="button" className="button button-secondary" onClick={() => setBringing(true)}>Bring in a membership</button>} />
      {counts && (
        <div className="stat-grid">
          <StatTile icon="users" tone="success" label="Active" value={String(counts.active)} note={counts.in_grace ? `and ${counts.in_grace} in their grace days` : undefined} />
          <StatTile icon="clock" tone={counts.frozen ? "warning" : "neutral"} label="Frozen" value={String(counts.frozen)} note={counts.upcoming ? `${counts.upcoming} not started yet` : undefined} />
          <StatTile icon="calendar" tone={counts.ending_7 ? "warning" : "neutral"} label="Ending in 7 days" value={String(counts.ending_7)} note={`${counts.ended_30} ended in the last 30 days`} />
          <StatTile icon="check" label="Checked in today" value={String(counts.checkins_today)} note={counts.refused_today ? `${counts.refused_today} turned away` : undefined} />
        </div>
      )}
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Members">
        <div className="fe-chips" role="group" aria-label="Membership status">
          {CHIPS.map(([value, label]) => (
            <button key={value || "all"} type="button" aria-pressed={status === value} className={`fe-chip ${status === value ? "is-active" : ""}`} onClick={() => setStatus(value)}>{label}</button>
          ))}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Name, phone, member code or membership number" }} caption="Members" columns={columns}
          rowKey={(r) => r.contact_id} rowNoun={["member", "members"]} currency={biz.symbol} onRowClick={(r) => navigate(biz.path(`members/${r.contact_id}`))}
          rowClassName={(r) => (r.status === "frozen" ? "dg-tone-warning" : r.status === "expired" && !r.in_grace ? "dg-tone-muted" : "")}
          exportName={biz.can("member_plans.export") ? `${biz.business.code}-members` : undefined}
          empty="No members yet" emptyHint={canSell ? "Sell a membership: the member gets a code with their first one." : undefined} emptyIcon="users" />
      </SectionCard>
      {bringing && <BringInDialog onClose={() => setBringing(false)}
        onSaved={(m) => { setBringing(false); toast.success(`${m.membership_no} brought in for ${m.member_name}.`); navigate(biz.path(`members/${m.contact_id}`)); }} />}
      {selling && <MembershipDialog mode="sell" onClose={() => setSelling(false)}
        onSaved={(m) => { setSelling(false); toast.success(`${m.membership_no} sold: ${m.plan_name} for ${m.member_name} (${m.member_code}).`); navigate(biz.path(`members/${m.contact_id}`)); }} />}
    </div>
  );
}
