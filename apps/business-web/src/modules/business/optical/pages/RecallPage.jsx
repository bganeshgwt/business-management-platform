import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { recallLink } from "./optical";
import "../styles/optical.css";

// The recall list: every customer whose last eye test was the shop's recall
// months ago or more (12 until changed here), longest due first, with their
// phone, when they were last reminded and their last order. A reminder opens
// WhatsApp with the message ready (or a call), and is kept, so the list shows
// who was reminded in the last 30 days.
export default function RecallPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [notReminded, setNotReminded] = useState(false);
  const list = useServerList("optical/recall", { gridId: "optical-recall", params: notReminded ? { reminded: "false" } : {} });
  const [settings, setSettings] = useState(null);
  const [months, setMonths] = useState("");
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "optical/settings", undefined, controller.signal)
      .then((s) => { setSettings(s); setMonths(String(s.recall_months)); })
      .catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await businessWrite(biz.id, "optical/settings", { recallMonths: months }, "put");
      toast.success(`Customers are due ${saved.recall_months} months after their last eye test.`);
      setVersion((n) => n + 1);
      list.reload();
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setSaving(false); }
  };
  const remind = (row, channel) => {
    if (channel === "whatsapp" && row.phone) window.open(recallLink(biz, row), "_blank", "noopener");
    businessWrite(biz.id, `optical/recall/${row.contact_id}/reminders`, { channel })
      .then(() => { toast.success(`Reminder to ${row.name} noted.`); list.reload(); })
      .catch((err) => toast.error(getErrorMessage(err)));
  };

  const columns = useMemo(() => [
    { key: "name", header: "Customer", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <button type="button" className="link-button bz-link-left" onClick={() => navigate(biz.path(`prescriptions/${r.contact_id}`))}>{r.name}</button> },
    { key: "phone", header: "Phone", value: (r) => r.phone || "", mobile: "subtitle", render: (r) => r.phone || <span className="muted">No phone</span> },
    { key: "examined_on", header: "Last eye test", type: "date", value: (r) => r.examined_on,
      render: (r) => <span className="bz-two-line"><span>{dateShort(r.examined_on, { year: true })}</span><small className="muted">{r.examiner_name}</small></span> },
    { key: "due_on", header: "Due since", type: "date", value: (r) => r.due_on, mobile: "show",
      render: (r) => <span className="bz-two-line"><span>{dateShort(r.due_on, { year: true })}</span><small className="muted">{Number(r.days_overdue) === 0 ? "today" : `${r.days_overdue} days`}</small></span> },
    { key: "reminded_at", header: "Last reminded", type: "date", value: (r) => r.reminded_at,
      render: (r) => (r.reminded_at ? <span className="bz-two-line"><span>{dateShort(r.reminded_at)}</span><small className="muted">{r.reminders} {r.reminders === 1 ? "reminder" : "reminders"}</small></span> : <span className="muted">Never</span>) },
    { key: "last_order_no", header: "Last order", value: (r) => r.last_order_no || "", className: "mono", defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {r.phone && <button type="button" className="chip-button" onClick={() => remind(r, "whatsapp")}><Icon name="message" size={14} /> WhatsApp</button>}
        {r.phone && <a className="chip-button" href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} onClick={() => remind(r, "call")}><Icon name="phone" size={14} /> Call</a>}
      </span>
    ) },
  ], [biz, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <BusinessHeader icon="bell" title="Recall list"
        description={`Customers whose last eye test was ${settings ? settings.recall_months : 12} months ago or more, longest due first. WhatsApp opens with the reminder ready; each reminder is kept.`} />
      {biz.can("settings.edit") && (
        <SectionCard icon="settings" title="When a customer is due">
          <form className="opt-setting" onSubmit={save}>
            <Field label="Months after the last eye test"><input type="number" min="1" max="60" step="1" required value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
            <button type="submit" className="button button-secondary" disabled={saving || !settings || months === String(settings.recall_months)}>{saving ? "Saving…" : "Save"}</button>
            {settings?.updated_by_name && <small className="muted">Set by {settings.updated_by_name} on {dateShort(settings.updated_at, { year: true })}</small>}
          </form>
        </SectionCard>
      )}
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="bell" title="Due for an eye test">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Customer, phone or examiner" }} caption="Customers due for an eye test" columns={columns}
          rowNoun={["customer", "customers"]}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={notReminded} onChange={(e) => setNotReminded(e.target.checked)} /> Not reminded in the last 30 days</label>}
          rowClassName={(r) => (r.reminded_recently ? "dg-tone-muted" : "")}
          exportName={biz.can("contacts.export") ? `${biz.business.code}-recall` : undefined}
          empty="Nobody is due for an eye test" emptyHint="Customers show here once their last test is old enough." emptyIcon="bell" />
      </SectionCard>
    </div>
  );
}
