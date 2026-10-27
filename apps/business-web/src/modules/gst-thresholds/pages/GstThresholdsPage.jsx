import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { moneyShort } from "@bmp/shared/format";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import StatTile from "../../../components/StatTile";
import StatusBadge from "../../../components/StatusBadge";
import DataGrid from "../../../components/DataGrid/DataGrid";
import { ErrorMessage, ScreenLoading, SuccessMessage } from "../../../components/Feedback";
import useBusiness from "../../../hooks/useBusiness";
import { getErrorMessage } from "../../../services/api";
import FormDialog from "../../business/core/pages/FormDialog";
import { Field } from "../../business/core/pages/ui";
import { ownerThresholds, recordPan, setWarnLevel } from "../services/gstThresholds.service";
import {
  canRecord, dayWords, figureWords, fixPath, fromWords, groupBadge, groupState, hsnWhen, longDayWords, panShaped, readWarnPercent, reasonWords, sourceWords,
  stepBadge, tidyPan, yearAfterFrom,
} from "../gstThresholds";
import "../styles/gst-thresholds.css";

// The owner's GST thresholds (/business-admin/gst-thresholds), beside Your
// businesses: every business this person owns, grouped by the PAN it trades
// under, with each group's turnover this financial year so far, the year
// before and the year at the pace so far, where it stands against each figure
// the platform keeps (e-invoicing and 6-digit HSN / SAC codes above ₹5 crore,
// the IRP's 30 days at ₹10 crore or more: passed last year, a figure applies
// now; passed this year so far, from the next 1 April), the codes to fix once
// 6-digit codes apply or are coming, the businesses with no PAN yet, the
// owner's own warning level, and the figures with their sources. Only an
// owner sees any of it.
export default function GstThresholdsPage() {
  const { businesses, switchTo } = useBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    ownerThresholds(controller.signal)
      .then((answer) => { setData(answer); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [version]);
  const reload = () => setVersion((n) => n + 1);

  // A business opens as it does from the switcher (the signed-in restaurant: its own admin).
  const openable = (business) => businesses.find((b) => b.id === business.id && !(b.business_type === "restaurant" && !b.is_signed_in_restaurant));
  const open = (business) => { const entry = openable(business); if (entry) switchTo(entry); };

  return (
    <div className="stack gst-page">
      <PageHeader icon="trend-up" eyebrow="Your businesses" title="GST thresholds"
        description="The turnover of your businesses added up under each PAN for the financial year, against the turnover at which e-invoicing, 6-digit HSN / SAC codes and the 30-day limit for reporting to the IRP apply."
        secondary={<Link className="button button-secondary" to="/business-admin?all=1"><Icon name="grid" size={16} /> All businesses</Link>} />
      <ErrorMessage message={error} />
      <SuccessMessage message={notice} />
      {!data && !error && <ScreenLoading label="Adding up your businesses' turnover…" />}
      {data && !data.owner && (
        <SectionCard icon="info" title="For a business's owner">
          <p className="muted">Only the owner of a business sees its turnover here. Where your role may see a business&apos;s money, its bell warns you when the turnover under its PAN nears or passes a figure.</p>
        </SectionCard>
      )}
      {data?.owner && (
        <>
          {data.groups.length === 0 && (
            <SectionCard icon="info" title="No business linked to a PAN yet">
              <p className="muted">A business counts under the PAN its GSTIN carries. Add each business&apos;s GSTIN in its settings, or record the PAN of one that has none below.</p>
            </SectionCard>
          )}
          {data.groups.map((group) => <PanGroup key={group.pan} group={group} data={data} openable={openable} onOpen={open} onRecord={setRecording} />)}
          {data.notLinked.length > 0 && <NotLinked data={data} openable={openable} onOpen={open} onRecord={setRecording} />}
          <WarnLevel key={data.warnPercent} warnPercent={data.warnPercent}
            onSaved={(level) => { setNotice(`You are warned from ${level}% of each figure.`); reload(); }} />
        </>
      )}
      {data && <Figures data={data} />}
      {recording && (
        <RecordPanDialog business={recording} onClose={() => setRecording(null)}
          onSaved={(result) => { setRecording(null); setNotice(result.pan ? `${recording.name} counts under PAN ${result.pan}.` : `${recording.name} has no PAN recorded now.`); reload(); }} />
      )}
    </div>
  );
}

// One PAN: its sums, where they stand against each figure, and its businesses.
function PanGroup({ group, data, openable, onOpen, onRecord }) {
  const state = groupState(group.steps);
  const badge = groupBadge(group.steps);
  const count = group.businesses.length;
  const columns = [
    { key: "name", header: "Business", value: (b) => b.name, mobile: "title", pin: true,
      render: (b) => <span className="bz-two-line"><strong>{b.name}</strong><small className="muted">{b.typeName}</small></span> },
    { key: "source", header: "Its PAN", value: (b) => sourceWords(b), mobile: "subtitle" },
    { key: "this_year", header: `This year so far`, type: "money", exact: true, value: (b) => Number(b.thisYear), total: "sum", mobile: "show" },
    { key: "last_year", header: `Last year`, type: "money", exact: true, value: (b) => Number(b.lastYear), total: "sum" },
    { key: "projected", header: "At this pace", type: "money", value: (b) => Number(b.projected), total: "sum" },
    group.hsn.applies && { key: "hsn", header: "HSN / SAC to fix", type: "number", value: (b) => b.hsnToFix, mobile: "show",
      render: (b) => (b.hsnToFix > 0 ? <Link to={fixPath(b)}>{b.hsnToFix} to fix</Link> : <span className="muted">None</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (b) => (
      <span className="bz-row-actions">
        {openable(b) && <button type="button" className="chip-button" onClick={() => onOpen(b)}>Open</button>}
        {b.source === "recorded" && <button type="button" className="chip-button" onClick={() => onRecord(b)}>Change PAN</button>}
      </span>
    ) },
  ].filter(Boolean);
  return (
    <SectionCard className="gst-group" icon="shield" tone={state === "crossed" ? "danger" : state === "near" ? "warning" : "area"}
      title={`PAN ${group.pan}`}
      description={`${count} ${count === 1 ? "business" : "businesses"} · financial year ${data.year.label}, to ${dayWords(data.today)}`}
      actions={<StatusBadge tone={badge.tone} label={badge.label} />}>
      <div className="stat-grid gst-sums">
        <StatTile icon="trend-up" tone="primary" label={`This year so far, ${data.year.label}`} money={Number(group.thisYear)} />
        <StatTile icon="history" label={`Last year, ${data.lastYear.label}`} money={Number(group.lastYear)} />
        <StatTile icon="chart" label="At this pace, by 31 March" money={Number(group.projected)} note="Each business's pace so far this year, over the whole year" />
      </div>
      <ul className="gst-steps">
        {group.steps.map((step) => <Step key={`${step.turnover}-${step.comparison}`} step={step} data={data} />)}
      </ul>
      {group.hsn.applies && (
        <p className="gst-note">
          <Icon name="alert" size={16} /> Every invoice of these businesses carries a {group.hsn.digits}-digit HSN / SAC code {hsnWhen(group.hsn)}. Each business&apos;s items with a shorter code, or none, are listed on its catalogue (a restaurant: on its tax rates) to fix.
        </p>
      )}
      <DataGrid id="gst-group-businesses" caption={`Businesses under PAN ${group.pan}`} columns={columns} rows={group.businesses} rowKey={(b) => b.id}
        variant="compact" pageSize={false} rowNoun={["business", "businesses"]} />
    </SectionCard>
  );
}

// Where the group stands against one figure (one or more rules at one turnover).
function Step({ step, data }) {
  const badge = stepBadge(step);
  return (
    <li className={`gst-step tone-${badge.tone}`}>
      <div className="gst-step-head">
        <StatusBadge tone={badge.tone} label={badge.label} />
        <strong>{step.words}</strong>
      </div>
      <div className="gst-meter" role="img" aria-label={`${step.share}% of ${figureWords(step.turnover, step.comparison).toLowerCase()} this year so far`}>
        <span className="gst-meter-fill" style={{ width: `${Math.min(100, step.share)}%` }} />
        <span className="gst-meter-mark" style={{ left: `${data.warnPercent}%` }} title={`The warning from ${data.warnPercent}%`} />
      </div>
      <p className="muted small gst-step-note">
        {figureWords(step.turnover, step.comparison)}: {step.share}% of it this year so far · warned from {moneyShort(step.warnAt)}
        {step.onPace ? " · at this pace it passes by 31 March" : ""}
      </p>
      <ul className="gst-rules">
        {step.rules.map((rule) => <li key={rule.code}>{rule.applies}</li>)}
      </ul>
    </li>
  );
}

// The businesses counted under no PAN, and why.
function NotLinked({ data, openable, onOpen, onRecord }) {
  const columns = [
    { key: "name", header: "Business", value: (b) => b.name, mobile: "title", pin: true,
      render: (b) => <span className="bz-two-line"><strong>{b.name}</strong><small className="muted">{b.typeName}</small></span> },
    { key: "why", header: "Why", value: (b) => reasonWords(b), mobile: "subtitle" },
    { key: "this_year", header: `This year so far`, type: "money", exact: true, value: (b) => Number(b.thisYear), mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (b) => (
      <span className="bz-row-actions">
        {canRecord(b) && <button type="button" className="chip-button" onClick={() => onRecord(b)}>Record PAN</button>}
        {openable(b) && <button type="button" className="chip-button" onClick={() => onOpen(b)}>Open</button>}
      </span>
    ) },
  ];
  return (
    <SectionCard icon="alert" tone="warning" title="Not linked to a PAN"
      description={`${data.notLinked.length === 1 ? "This business is" : "These businesses are"} counted under no PAN until ${data.notLinked.length === 1 ? "it has" : "each has"} a GSTIN, or a PAN you record. A PAN is never guessed.`}>
      <DataGrid id="gst-not-linked" caption="Businesses not linked to a PAN" columns={columns} rows={data.notLinked} rowKey={(b) => b.id}
        variant="compact" pageSize={false} rowNoun={["business", "businesses"]} />
    </SectionCard>
  );
}

// The owner's own warning level.
function WarnLevel({ warnPercent, onSaved }) {
  const [value, setValue] = useState(String(warnPercent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const level = readWarnPercent(value);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved((await setWarnLevel(level)).warnPercent);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard as="form" onSubmit={save} icon="bell" title="When to warn"
      description="From this share of a figure, this page and the bell of each of your businesses under the PAN say the turnover is nearing it. The bells warn the people there who may see the business's money; the PAN shows in full to its owners only.">
      <ErrorMessage message={error} />
      <div className="gst-warn">
        <Field label="Warn from (% of a figure)" hint="A whole percent from 50 to 99.">
          <input type="number" inputMode="numeric" min="50" max="99" step="1" required value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <button type="submit" className="button" disabled={busy || level === null || level === warnPercent}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </SectionCard>
  );
}

// The figures the platform keeps, with their sources, and how turnover is counted.
function Figures({ data }) {
  const columns = [
    { key: "name", header: "What applies", value: (f) => f.name, mobile: "title",
      render: (f) => <span className="bz-two-line"><strong>{f.name}</strong><small className="muted">{f.applies}</small></span> },
    { key: "turnover", header: "Aggregate turnover", value: (f) => figureWords(f.turnover, f.comparison), mobile: "subtitle" },
    { key: "from", header: "Applies", value: (f) => (f.inForce ? fromWords(f.appliesFrom) : `${fromWords(f.appliesFrom)} (not yet)`) },
    { key: "source", header: "Source", value: (f) => f.source, render: (f) => <small className="gst-source">{f.source}</small> },
  ];
  return (
    <SectionCard icon="file" title="The figures, and how turnover is counted"
      description="The platform keeps these figures with their sources, and an accountant checks them; a change comes with an update of the platform.">
      <DataGrid id="gst-figures" caption="The figures for GST thresholds" columns={columns} rows={data.thresholds} rowKey={(f) => `${f.code}-${f.appliesFrom || ""}`}
        variant="compact" pageSize={false} rowNoun={["figure", "figures"]} />
      <ul className="gst-notes">
        <li>Turnover is each business&apos;s sales less what came back, before GST, on its own dates and clock: a shop&apos;s bills and returns on their days, a restaurant&apos;s bills and credit notes on their business days. Only what is billed here counts: a business&apos;s sales from before it came onto the platform, and those of a GSTIN under the PAN that is not on the platform, are yours to add.</li>
        <li>Every business you own under one PAN counts together, a branch registered in another state too. A business with no GSTIN counts under the PAN you record for it.</li>
        <li>Nil-rated and exempt sales count, and so do a fuel station&apos;s petrol and diesel, which are outside GST: that is how the platform&apos;s research reads aggregate turnover, and an accountant has still to check it.</li>
        <li>A figure applies for a financial year when the year before passed it: passed last year ({data.lastYear.label}), it applies now; passed this year so far ({data.year.label}), it applies from {longDayWords(yearAfterFrom(data.year))}. The projection is each business&apos;s pace this year (from 1 April, or the day it came onto the platform) over the whole year.</li>
        <li>Nothing here files a return or makes an e-invoice: e-invoices are made through the IRP, outside the platform.</li>
      </ul>
    </SectionCard>
  );
}

// The PAN of a business that has no GSTIN; empty clears it.
function RecordPanDialog({ business, onClose, onSaved }) {
  const [pan, setPan] = useState(business.recordedPan || "");
  const typed = tidyPan(pan);
  return (
    <FormDialog title={`The PAN ${business.name} trades under`} icon="shield" width={520} submitLabel={typed ? "Save PAN" : "Clear PAN"}
      description="For a business with no GSTIN: its turnover then counts with your other businesses under this PAN. Once it has a GSTIN, its PAN comes from the GSTIN."
      onClose={onClose} onSaved={onSaved} onSubmit={() => recordPan(business.id, typed)}>
      <Field label="PAN" hint={typed && !panShaped(typed) ? "Five letters, four digits and a letter, like ABCDE1234F." : "Ten characters, like ABCDE1234F. Leave it empty to clear the one recorded."} wide>
        <input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} maxLength={12} autoComplete="off" spellCheck={false} className="mono" />
      </Field>
    </FormDialog>
  );
}
