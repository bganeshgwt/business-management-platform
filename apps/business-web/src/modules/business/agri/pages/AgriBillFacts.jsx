import { dateShort } from "@bmp/shared/format";
import { kindWord, seasonWord } from "./agri";
import "../styles/agri.css";

// On a farm-input shop's bill (Sales history › a bill): its season credit,
// the farmer, each line's PoS receipt and crop, and the licences the
// location sold under that day.
export default function AgriBillFacts({ doc }) {
  const a = doc.agri;
  if (!a) return null;
  const labelOf = (lineId) => doc.lines.find((l) => l.id === lineId)?.label || "";
  const noted = a.lines.filter((l) => l.pos_receipt || l.crop);
  const farmer = a.farmer;
  return (
    <div className="agri-bill-facts small">
      {a.bill?.season && <p>Season credit <strong>{seasonWord(a.bill.season, a.bill.season_year)}</strong>{doc.due_on ? `, due at the harvest on ${dateShort(doc.due_on, { year: true })}` : ""}</p>}
      {farmer && <p>Farmer of <strong>{farmer.village}</strong>{farmer.relative_name ? ` · father's or husband's name ${farmer.relative_name}` : ""}{farmer.farmer_id ? ` · Farmer ID ${farmer.farmer_id}` : ""}</p>}
      {(a.bill?.buyer_name || a.bill?.village) && <p>Farmer <strong>{[a.bill.buyer_name, a.bill.village].filter(Boolean).join(", ")}</strong></p>}
      {noted.map((l) => (
        <p key={l.line_id}>{labelOf(l.line_id)} ({kindWord(l.input_kind).toLowerCase()}){l.pos_receipt ? ` · PoS receipt ${l.pos_receipt}` : ""}{l.crop ? ` · for ${l.crop}` : ""}</p>
      ))}
      {a.licences.length > 0 && <p className="muted">Sold under {a.licences.map((l) => `${l.name} ${l.licence_no}`).join(" · ")}</p>}
    </div>
  );
}
