import { dateShort } from "@bmp/shared/format";
import { kindWord, seasonWord, tagWord } from "./agri";
import "../styles/agri.css";

// On a farm-input shop's bill (Sales history › a bill): its season credit,
// the interest it bills, the farmer, each line's PoS receipt, crop, advisory
// line and who a restricted-use pesticide went to, the buyer's tags and the
// licences the location sold under that day.
const RESTRICTED = { pest_control_operator: "to a pest-control operator", government: "to a government body", override: "on a manager's override" };

export default function AgriBillFacts({ doc }) {
  const a = doc.agri;
  if (!a) return null;
  const labelOf = (lineId) => doc.lines.find((l) => l.id === lineId)?.label || "";
  const noted = a.lines.filter((l) => l.pos_receipt || l.crop || l.advisory || l.restricted_by || l.off_label);
  const farmer = a.farmer;
  return (
    <div className="agri-bill-facts small">
      {a.bill?.season && <p>Season credit <strong>{seasonWord(a.bill.season, a.bill.season_year)}</strong>{doc.due_on ? `, due ${a.interest ? "at once" : `at the harvest on ${dateShort(doc.due_on, { year: true })}`}` : ""}</p>}
      {a.interest && <p>Interest on overdue season credit, worked out to {dateShort(a.interest.worked_to, { year: true })}</p>}
      {farmer && <p>Farmer of <strong>{farmer.village}</strong>{farmer.relative_name ? ` · father's or husband's name ${farmer.relative_name}` : ""}{farmer.farmer_id ? ` · Farmer ID ${farmer.farmer_id}` : ""}</p>}
      {(a.bill?.buyer_name || a.bill?.village) && <p>Farmer <strong>{[a.bill.buyer_name, a.bill.village].filter(Boolean).join(", ")}</strong></p>}
      {a.bill?.buyer_tags?.length > 0 && <p>Buyer: {a.bill.buyer_tags.map(tagWord).join(", ")}</p>}
      {a.bill?.bag_override && <p>Subsidised bags over the month's limit, allowed by a manager: {a.bill.bag_override}</p>}
      {noted.map((l) => (
        <p key={l.line_id}>
          {labelOf(l.line_id)} ({kindWord(l.input_kind).toLowerCase()}){l.pos_receipt ? ` · PoS receipt ${l.pos_receipt}` : ""}{l.crop ? ` · for ${l.crop}` : ""}
          {l.off_label ? " · not on its label for that crop" : ""}{l.restricted_by ? ` · sold ${RESTRICTED[l.restricted_by]}` : ""}
          {l.advisory && <><br /><span className="muted">{l.advisory}</span></>}
        </p>
      ))}
      {a.licences.length > 0 && <p className="muted">Sold under {a.licences.map((l) => `${l.name} ${l.licence_no}`).join(" · ")}</p>}
    </div>
  );
}
