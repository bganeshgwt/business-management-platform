import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { moneyShort } from "@bmp/shared/format";
import SectionCard from "../../../components/SectionCard";
import StatusBadge from "../../../components/StatusBadge";
import { ownerThresholds } from "../services/gstThresholds.service";
import { groupBadge, mostSerious } from "../gstThresholds";
import "../styles/gst-thresholds.css";

// On Your businesses, for an owner: each PAN's turnover this financial year
// so far and the most serious figure it nears or has passed (applying now, or
// from the next 1 April), with the way into the full view. Nothing for
// someone who owns no business.
export default function OwnerThresholdsCard() {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    // Only a summary: a failure leaves it out rather than holding up the page.
    ownerThresholds(controller.signal).then(setData).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!data?.owner || (data.groups.length === 0 && data.notLinked.length === 0)) return null;
  const unlinked = data.notLinked.length;
  return (
    <SectionCard icon="trend-up" title="GST thresholds" className="gst-summary-card"
      description={`Your businesses' turnover under each PAN this financial year (${data.year.label}), against the figures for e-invoicing, 6-digit HSN / SAC codes and the IRP's 30 days.`}
      actions={<Link className="button button-secondary button-sm" to="/business-admin/gst-thresholds">Open GST thresholds</Link>}>
      <ul className="gst-summary">
        {data.groups.map((group) => {
          const step = mostSerious(group.steps);
          const badge = groupBadge(group.steps);
          return (
            <li key={group.pan}>
              <StatusBadge tone={badge.tone} label={step ? badge.label : "Below"} />
              <strong>PAN {group.pan}</strong>
              <span>{moneyShort(group.thisYear)} so far · {group.businesses.length} {group.businesses.length === 1 ? "business" : "businesses"}</span>
              <span className="muted">{step ? step.words : "Below every figure"}</span>
            </li>
          );
        })}
        {unlinked > 0 && (
          <li>
            <StatusBadge tone="warning" label="Not linked" />
            <span>{unlinked} {unlinked === 1 ? "business has" : "businesses have"} no PAN yet</span>
          </li>
        )}
      </ul>
    </SectionCard>
  );
}
