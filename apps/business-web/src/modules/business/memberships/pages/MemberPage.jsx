import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { printTaxInvoice } from "../../core/pages/invoice";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";
import MembershipDialog from "./MembershipDialog";
import { CancelDialog, FreezeDialog, TransferDialog } from "./ChangeDialogs";
import { printMembership } from "./membershipPrint";
import { EVENT_WORDS, HOW, INSTALMENT_STATUSES, REASONS, dayWords, endWords, isRunning, messageLink, renewalMessage, runWords, statusOf } from "./memberships";
// A renewal reminder needs the member's consent to reminders (asked first, in one tap).
import ConsentLink from "../../../personal-data/components/ConsentLink";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import "../styles/memberships.css";

// One member on screen: their code and their memberships, the current ones
// first, each with its terms as sold (the price, the policy version, the
// freezes left), its bill and what is still to pay, its instalments, its
// history and the steps this person may take (renew, upgrade, freeze or end
// the freeze, pass it on, cancel); the member's last check-ins; a check-in
// now; the membership slip with its policy and the member's code as a QR.

export default function MemberPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { contactId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `member-plans/members/${contactId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!data) return <div className="stack"><BusinessHeader icon="user" title="Member" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const { member, memberships, checkins, money } = data;
  const current = memberships.find(isRunning) || memberships[0] || null;
  const canSell = biz.can("member_plans.create") && biz.can("sales.create");
  const canEdit = biz.can("member_plans.edit");
  const checkIn = () => businessWrite(biz.id, "member-plans/check-ins", { requestKey: newKey(), locationId: biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id, contactId: member.id })
    .then((k) => {
      if (k.allowed) refresh(`${member.name} is in${k.sessions_left !== null && k.sessions_left !== undefined ? `: ${k.sessions_left} sessions left` : ""}.`);
      else { toast.error(k.words); refresh(); }
    })
    .catch((err) => toast.error(getErrorMessage(err)));
  return (
    <div className="stack">
      <BusinessHeader icon="user" title={member.name}
        description={[member.member_code ? `Member ${member.member_code}` : "No member code yet", member.phone, member.member_since ? `member since ${dayWords(member.member_since)}` : null].filter(Boolean).join(" · ")}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("members")}><Icon name="arrow-left" size={15} /> All members</Link>
            {member.phone && <a className="button button-secondary" href={`tel:${member.phone.replace(/[^\d+]/g, "")}`}><Icon name="phone" size={15} /> Call</a>}
          </>
        )}
        primary={biz.can("member_plans.create") && <button type="button" className="button" onClick={checkIn}><Icon name="check" size={16} /> Check in now</button>} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="users" tone={current ? statusOf(current).tone : "neutral"} label="Membership" value={current ? statusOf(current).label : "None yet"}
          note={current ? `${current.plan_name} · ${current.membership_no}` : undefined} />
        <StatTile icon="calendar" label={current?.end_on ? "Last day" : "Sessions left"} value={current ? (current.end_on ? dayWords(current.end_on) : String(current.sessions_left ?? "—")) : "—"}
          note={current ? endWords(current) || undefined : undefined} />
        {money && <StatTile icon="wallet" tone={Number(member.dues) > 0 ? "danger" : "neutral"} label="Dues" money={Math.max(0, Number(member.dues))}
          note={Number(member.dues) < 0 ? `${biz.exact(-Number(member.dues))} paid in advance` : undefined} />}
        <StatTile icon="clock" label="Last check-in" value={checkins.find((k) => k.allowed) ? dateTime(checkins.find((k) => k.allowed).created_at) : "Never"} />
      </div>
      <SectionCard icon="user-plus" title="Memberships"
        actions={(
          <span className="bz-row-actions">
            {canSell && <button type="button" className="button button-sm" onClick={() => setDialog({ kind: "sell" })}><Icon name="plus" size={14} /> Sell a membership</button>}
            {canEdit && member.member_code && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "code" })}>Member code</button>}
          </span>
        )}>
        {!memberships.length && <p className="muted">No membership yet. Sell one to give {member.name} a member code.</p>}
        <div className="mem-cards">
          {memberships.map((m) => <MembershipCard key={m.id} m={m} member={member} onDialog={(kind) => setDialog({ kind, m })} />)}
        </div>
      </SectionCard>
      <SectionCard flush icon="clock" title="Check-ins" description="The last 30, let in or turned away.">
        <DataGrid variant="compact" id="member-checkins" caption="Check-ins" rows={checkins} rowKey={(k) => k.id} rowNoun={["check-in", "check-ins"]}
          empty="No check-ins yet" columns={[
            { key: "created_at", header: "When", type: "datetime", value: (k) => k.created_at, mobile: "title" },
            { key: "allowed", header: "", value: (k) => (k.allowed ? "In" : REASONS[k.reason]), mobile: "subtitle",
              render: (k) => <Badge tone={k.allowed ? "success" : "danger"} label={k.allowed ? (k.session_used ? "In · a session used" : "In") : REASONS[k.reason]} /> },
            { key: "membership_no", header: "Membership", value: (k) => k.membership_no || "", className: "mono" },
            { key: "note", header: "Note", value: (k) => k.note || "" },
            { key: "by", header: "At", value: (k) => `${k.location_name} · ${k.by_name}`, defaultHidden: true },
          ]} />
      </SectionCard>
      {dialog?.kind === "sell" && <MembershipDialog mode="sell" member={member} onClose={() => setDialog(null)} onSaved={(r) => refresh(`${r.membership_no} sold: ${r.plan_name}.`)} />}
      {dialog?.kind === "renew" && <MembershipDialog mode="renew" member={member} membership={dialog.m} onClose={() => setDialog(null)} onSaved={(r) => refresh(`Renewed: ${r.membership_no} from ${dayWords(r.start_on)}.`)} />}
      {dialog?.kind === "upgrade" && <MembershipDialog mode="upgrade" member={member} membership={dialog.m} onClose={() => setDialog(null)} onSaved={(r) => refresh(`Upgraded to ${r.plan_name} (${r.membership_no}).`)} />}
      {dialog?.kind === "freeze" && <FreezeDialog membership={dialog.m} onClose={() => setDialog(null)} onSaved={() => refresh(`${dialog.m.membership_no} frozen.`)} />}
      {dialog?.kind === "transfer" && <TransferDialog membership={dialog.m} onClose={() => setDialog(null)}
        onSaved={(r) => { setDialog(null); toast.success(`${dialog.m.membership_no} passed on to ${r.member_name} (${r.membership_no}).`); navigate(biz.path(`members/${r.contact_id}`)); }} />}
      {dialog?.kind === "cancel" && <CancelDialog membership={dialog.m} onClose={() => setDialog(null)}
        onSaved={(r) => refresh(`${r.membership_no} cancelled${Number(r.refunded) > 0 ? `: ${biz.exact(r.refunded)} refunded` : ""}.`)} />}
      {dialog?.kind === "code" && <CodeDialog member={member} onClose={() => setDialog(null)} onSaved={() => refresh("Member code changed.")} />}
      {dialog?.kind === "unfreeze" && (
        <FormDialog title={`End the freeze of ${dialog.m.membership_no}`} icon="clock" width={520} onClose={() => setDialog(null)} submitLabel="The member is back"
          description="The freeze ends today (a freeze still to come is called off); the days not frozen are given back and the last day moves back with them."
          onSubmit={() => businessWrite(biz.id, `member-plans/memberships/${dialog.m.id}/unfreeze`, {})} onSaved={() => refresh("Welcome back: the freeze has ended.")} />
      )}
    </div>
  );
}

function MembershipCard({ m, member, onDialog }) {
  const biz = useOpenBusiness();
  const privacy = useShopPrivacy();
  const status = statusOf(m);
  const running = ["upcoming", "active", "frozen"].includes(m.status);
  const money = m.money !== false;
  const canSell = biz.can("member_plans.create") && biz.can("sales.create");
  const canEdit = biz.can("member_plans.edit");
  const freezing = (m.freezes || []).find((f) => f.current || f.ahead);
  const renewable = !m.closed && !(m.followed_by || []).some((f) => f.how === "renewal") && (running || m.in_grace || m.status === "expired" || m.status === "used_up");
  const text = renewalMessage(biz, { ...m, member_name: member.name });
  return (
    <article className={`mem-card mem-card-${m.status}`}>
      <header className="mem-card-head">
        <div>
          <h3>{m.plan_name} <span className="muted mono">{m.membership_no}</span></h3>
          <small className="muted">{runWords(m)}{m.frozen_days ? ` · ${m.frozen_days} days frozen` : ""}{endWords(m) ? ` · ${endWords(m)}` : ""}</small>
        </div>
        <Badge tone={status.tone} label={status.label} />
      </header>
      <dl className="fe-facts">
        <dt>Term</dt><dd>{m.term}{m.grace_days ? ` · ${m.grace_days} grace days` : ""}{m.transferable ? " · can be passed on" : ""}</dd>
        {money && <><dt>Price as sold</dt><dd>{biz.exact(m.price)} ({biz.exact(m.price_net)} + GST {biz.exact(m.price_tax)}){Number(m.joining_fee) > 0 ? ` · joining fee ${biz.exact(m.joining_fee)}` : ""}</dd></>}
        {money && m.bill && <><dt>Bill</dt><dd><span className="mono">{m.bill.document_no}</span>
          {Number(m.bill.due) > 0 ? <span className="bz-minus"> · {biz.exact(m.bill.due)} to pay</span> : " · paid"}</dd></>}
        {m.source_no && <><dt>{m.renewal_of ? "Renews" : m.upgraded_from ? "Upgraded from" : "Passed on from"}</dt><dd className="mono">{m.source_no}</dd></>}
        {(m.followed_by || []).map((f) => <Fragment key={f.id}><dt>{HOW[f.how]}</dt><dd><span className="mono">{f.membership_no}</span>{f.how === "transfer" ? ` · ${f.member_name}` : ""}</dd></Fragment>)}
        {m.max_freezes > 0 && running && <><dt>Freezes left</dt><dd>{m.freeze_left.freezes} freeze{m.freeze_left.freezes === 1 ? "" : "s"}, {m.freeze_left.days} days</dd></>}
        {freezing && <><dt>{freezing.current ? "Frozen" : "Freeze to come"}</dt><dd>{dayWords(freezing.starts_on)} for {freezing.days} days{freezing.reason ? ` · ${freezing.reason}` : ""}</dd></>}
        {m.closed && <><dt>{status.label}</dt><dd>{m.close_reason}{m.closed_by_name ? ` (${m.closed_by_name}, ${dateTime(m.closed_at)})` : ""}{money && m.credit ? ` · credit note ${m.return_no} for ${biz.exact(m.credit)}` : ""}
          {money && m.refunded ? ` · ${biz.exact(m.refunded)} refunded` : ""}{m.approved_by_name ? ` · approved by ${m.approved_by_name}` : ""}</dd></>}
        <dt>Refund policy</dt><dd>Version {m.policy_version}: {m.policy}</dd>
      </dl>
      <div className="form-actions bz-start">
        {renewable && canSell && <button type="button" className="button button-sm" onClick={() => onDialog("renew")}><Icon name="refresh" size={14} /> Renew</button>}
        {running && canEdit && canSell && !m.transferred_from && <button type="button" className="button button-secondary button-sm" onClick={() => onDialog("upgrade")}>Upgrade</button>}
        {running && canEdit && m.end_on && m.max_freezes > 0 && !freezing && m.freeze_left.freezes > 0 && m.freeze_left.days > 0 &&
          <button type="button" className="button button-secondary button-sm" onClick={() => onDialog("freeze")}><Icon name="clock" size={14} /> Freeze</button>}
        {freezing && canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => onDialog("unfreeze")}>{freezing.current ? "End the freeze" : "Call off the freeze"}</button>}
        {running && canEdit && m.transferable && m.status !== "frozen" && <button type="button" className="button button-secondary button-sm" onClick={() => onDialog("transfer")}><Icon name="users" size={14} /> Pass on</button>}
        {running && biz.can("member_plans.cancel") && <button type="button" className="button button-secondary button-sm" onClick={() => onDialog("cancel")}>Cancel</button>}
        {member.phone && m.end_on && !m.closed && (
          <ConsentLink privacy={privacy} purpose="reminders" person={{ id: member.id, name: member.name }} href={messageLink(member.phone, text)}
            className="button button-secondary button-sm"><Icon name="message" size={14} /> WhatsApp</ConsentLink>
        )}
        <button type="button" className="button button-secondary button-sm" onClick={() => printMembership(biz, m, member)}><Icon name="print" size={14} /> Membership slip</button>
        {money && m.bill && biz.can("sales.print") && (
          <button type="button" className="button button-secondary button-sm"
            onClick={() => businessRead(biz.id, `documents/${m.bill.id}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)))}>
            <Icon name="receipt" size={14} /> The bill
          </button>
        )}
      </div>
      {m.instalments?.length > 0 && (
        <DataGrid variant="compact" id="member-instalments" caption="Instalments" rows={m.instalments} rowKey={(i) => i.seq} rowNoun={["instalment", "instalments"]} currency={biz.symbol} columns={[
          { key: "seq", header: "No.", type: "number", value: (i) => i.seq, mobile: "title" },
          { key: "due_on", header: "Due on", type: "date", value: (i) => i.due_on, mobile: "subtitle" },
          money && { key: "amount", header: "Amount", type: "money", exact: true, value: (i) => Number(i.amount), total: "sum" },
          money && { key: "covered", header: "Paid", type: "money", exact: true, value: (i) => Number(i.covered), total: "sum" },
          { key: "status", header: "", value: (i) => INSTALMENT_STATUSES[i.status]?.label, mobile: "show",
            render: (i) => <Badge tone={INSTALMENT_STATUSES[i.status]?.tone} label={`${INSTALMENT_STATUSES[i.status]?.label}${i.days_overdue ? ` · ${i.days_overdue} days` : ""}`} /> },
        ].filter(Boolean)} />
      )}
      {m.events?.length > 0 && (
        <details className="mem-history">
          <summary>History ({m.events.length})</summary>
          <ol>{m.events.map((e) => <li key={e.id}><strong>{EVENT_WORDS[e.kind] || e.kind}</strong> · {e.note} <small className="muted">{dateTime(e.created_at)} · {e.by_name}</small></li>)}</ol>
        </details>
      )}
    </article>
  );
}

function CodeDialog({ member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [code, setCode] = useState(member.member_code || "");
  return (
    <FormDialog title="Member code" icon="qr" width={480} onClose={onClose} onSaved={onSaved} submitLabel="Save"
      description="The code printed on the member's card and typed or scanned at the desk: the number on a card they already hold, say."
      onSubmit={() => businessWrite(biz.id, `member-plans/members/${member.id}/code`, { code }, "put")}>
      <Field label="Code"><input required maxLength={20} className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>
    </FormDialog>
  );
}
