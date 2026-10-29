import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../components/StatusBadge";
import { SuccessMessage } from "../../../components/Feedback";
import { dateTime } from "@bmp/shared/format";
import TaxChangeTool from "./TaxChangeTool";
import TaxChangeDialog from "./TaxChangeDialog";
import TaxImportTool from "./TaxImportTool";
import SettingRatesCard from "./SettingRatesCard";
import { STATES, keepsWords, onDate, plural, rateText } from "../taxChanges";
import "../styles/tax-changes.css";

// The GST rate changes of a shop's catalogue or a restaurant's menu: the ones
// still to come first, then those in force and those cancelled. The yearly
// change is entered here ahead of its date (New GST rate change).
//
// gridProps: the DataGrid's rows (a restaurant's list) or server paging (a
// shop's, useServerList); reload(): fetch them again. A notification's list of
// HSN / SAC codes is imported here too, and rates kept in settings (GST by
// price, room-night slabs, a restaurant's default rate) change by date in
// their own card. canEditSettings: may change those; help: a line of help
// under the header.
export default function TaxChangesView({ api, words, canEdit, canEditSettings = false, gridProps, reload, rates, categories, pricesInclude, today, currency = "₹", description, help }) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState("");

  const columns = [
    { key: "starts", header: "From", type: "date", value: (c) => c.starts_on, mobile: "title", pin: true, render: (c) => <strong>{onDate(c.starts_on)}</strong> },
    { key: "rate", header: "Moves to", value: (c) => c.rate_name, mobile: "subtitle", render: (c) => <>{c.rate_name} <span className="muted">({rateText(c.rate)})</span></> },
    { key: "items", header: words.Items, type: "number", value: (c) => c.items, mobile: "show",
      render: (c) => (
        <span className="txc-two-line">
          <span>{plural(c.items, words.item, words.items)}</span>
          {(c.cancelled > 0 || c.refused > 0) && <small className="muted">{[c.cancelled && `${c.cancelled} cancelled`, c.refused && `${c.refused} refused`].filter(Boolean).join(" · ")}</small>}
        </span>
      ) },
    { key: "keeps", header: "Prices that include GST", value: (c) => keepsWords(c.keeps), defaultHidden: pricesInclude === false },
    { key: "reason", header: "Reason", value: (c) => c.reason },
    { key: "by", header: "Entered by", value: (c) => c.created_by_name, render: (c) => <span className="txc-two-line"><span>{c.created_by_name}</span><small className="muted">{dateTime(c.created_at)}</small></span>, defaultHidden: true },
    { key: "state", header: "State", type: "status", value: (c) => c.state, mobile: "show",
      render: (c) => <StatusBadge status={c.state} label={STATES[c.state]?.label || c.state} tone={STATES[c.state]?.tone || "neutral"} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => <button type="button" className="chip-button" onClick={() => setOpen(c.id)}>Open</button> },
  ];

  return (
    <div className="stack">
      <PageHeader icon="percent" title="GST rate changes" description={description}
        actions={canEdit && (
          <>
            <button type="button" className="button button-secondary" onClick={() => setImporting(true)} disabled={!today}><Icon name="upload" size={16} /> Import a notification's list</button>
            <button type="button" className="button" onClick={() => setCreating(true)} disabled={!today}><Icon name="plus" size={16} /> New GST rate change</button>
          </>
        )} />
      {help && <p className="muted small txc-help">{help}</p>}
      <SuccessMessage message={notice} />
      <SectionCard flush icon="calendar" title="Changes by date">
        <DataGrid {...gridProps} caption="GST rate changes" columns={columns} rowNoun={["change", "changes"]}
          rowClassName={(c) => (c.state === "cancelled" ? "dg-tone-muted" : "")}
          empty="No GST rate change yet" emptyIcon="percent"
          emptyHint={`When the GST Council changes rates (once a year, from 1 April), enter the change here ahead of the day: from that day every bill uses the new ${words.rate}.`} />
      </SectionCard>
      {creating && (
        <TaxChangeTool api={api} words={words} rates={rates} categories={categories} pricesInclude={pricesInclude} today={today} currency={currency}
          onClose={() => setCreating(false)}
          onScheduled={(change) => {
            setCreating(false);
            setNotice(`GST rate change from ${onDate(change.starts_on)} scheduled for ${plural(change.items.length, words.item, words.items)}.`);
            reload();
          }} />
      )}
      {importing && (
        <TaxImportTool api={api} words={words} pricesInclude={pricesInclude} today={today}
          onClose={() => setImporting(false)}
          onScheduled={(made) => {
            setImporting(false);
            setNotice(`The list is scheduled: ${made.changes.map((c) => `${c.rate_name} for ${plural(c.items, words.item, words.items)}`).join("; ")}, from ${onDate(made.changes[0]?.starts_on)}.`);
            reload();
          }} />
      )}
      <SettingRatesCard api={api} canEdit={canEditSettings} rates={rates} />
      {open && <TaxChangeDialog api={api} words={words} changeId={open} canEdit={canEdit} currency={currency} onClose={() => setOpen(null)} onChanged={() => reload()} />}
    </div>
  );
}
