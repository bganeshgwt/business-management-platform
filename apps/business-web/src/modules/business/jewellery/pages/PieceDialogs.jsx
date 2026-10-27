import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { dateTime, newKey } from "../../core/pages/hooks";
import { ALL_PURITIES, MAKING_MODES, OPEN_STATUSES, OUT_SCREENS, PIECE_STATUSES, grams, makingWords, netOf, perGram, purityWords, readHuids, readTags } from "./jewellery";
import { TAG_LAYOUTS, printPieceTags } from "./jewelleryPrint";
import JewelleryPhoto from "./JewelleryPhoto";

// The forms and the panel of Pieces & tags: a jewellery item with the
// defaults a new piece of it starts with; a piece tagged into stock (or on a
// unit bought in with its number) and changed while it is in the shop; a
// piece split into several, several merged into one, or a piece given a new
// tag (weight, fine weight and cost kept); the piece's panel with its
// weights, stones, HUIDs, photo, price at today's rate and history, and what
// can be done with it (send it on approval, to a karigar or for hallmarking
// on its challan, split it, give it a new tag, melt it, print its tag).
// Someone who does not see sales sees and types no prices or charges: a new
// piece then takes its item's charges.

const purityKey = (metal, purity) => `${metal}:${purity}`;
const splitKey = (key) => { const [metal, purity] = String(key).split(":"); return { metal, purity }; };

// A jewellery item: a new catalogue item made with it, or one already in the catalogue.
export function ItemForm({ biz, item, catalogue, onClose, onSaved }) {
  const money = biz.can("sales.view");
  const [form, setForm] = useState(() => ({ existing: "", name: "", hsnCode: "7113", code: "", purity: item ? purityKey(item.metal, item.purity) : "gold:22K",
    wastage: item ? String(item.wastage_percent ?? "") : "0", makingMode: item?.making_mode || "per_gram", makingValue: item ? String(item.making_value ?? "") : "0" }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const defaults = () => ({ ...splitKey(form.purity), makingMode: form.makingMode, ...(money ? { wastagePercent: form.wastage || "0", makingValue: form.makingValue || "0" } : {}) });
  const submit = () => {
    if (item) return businessWrite(biz.id, `jewellery/items/${item.sku_id}`, defaults(), "put");
    if (form.existing) return businessWrite(biz.id, "jewellery/items", { skuId: form.existing, ...defaults() });
    return businessWrite(biz.id, "jewellery/items", { item: { name: form.name.trim(), hsnCode: form.hsnCode.trim() || undefined, code: form.code.trim() || undefined }, ...defaults() });
  };
  return (
    <FormDialog title={item ? `${item.label}: what a new piece starts with` : "A jewellery item"} icon="tag" onClose={onClose} onSubmit={submit} onSaved={onSaved}
      description={item ? "A piece keeps its own charges; these are only where a new piece of this item starts." : "A catalogue item sold as tagged pieces priced by weight: goods counted in pieces, each with its serial number (its tag), at 3% GST."}
      successMessage={item ? "Saved." : "The item is ready for its pieces."}>
      {!item && (
        <>
          <Field label="An item already in the catalogue (optional)" wide hint="Goods counted in pieces, serial-numbered, at 3% GST. Leave empty to make a new item.">
            <select value={form.existing} onChange={set("existing")}>
              <option value="">Make a new item</option>
              {(catalogue || []).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.code})</option>)}
            </select>
          </Field>
          {!form.existing && (
            <>
              <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Gold necklace" /></Field>
              <Field label="HSN" hint="7113: jewellery of precious metal; 7114: silverware."><input maxLength={8} inputMode="numeric" value={form.hsnCode} onChange={set("hsnCode")} /></Field>
              <Field label="Item code (optional)" hint="Empty: the next JWL- number."><input maxLength={60} value={form.code} onChange={set("code")} /></Field>
            </>
          )}
        </>
      )}
      <Field label="Metal and purity"><select value={form.purity} onChange={set("purity")}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <Field label="Making charge"><select value={form.makingMode} onChange={set("makingMode")}>{MAKING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
      {money && (
        <>
          <Field label={form.makingMode === "percent" ? "Making (% of the metal's value)" : form.makingMode === "flat" ? "Making (₹ for the piece)" : "Making (₹ a gram)"}>
            <input type="number" min="0" step="0.01" value={form.makingValue} onChange={set("makingValue")} />
          </Field>
          <Field label="Wastage (% of the net weight)" hint="Value addition: grams added at the day's rate."><input type="number" min="0" max="100" step="0.01" value={form.wastage} onChange={set("wastage")} /></Field>
        </>
      )}
    </FormDialog>
  );
}

const blankStone = () => ({ key: newKey(), kind: "diamond", description: "", pieces: "1", carat: "", grade: "", certificate: "", treatment: "", value: "" });

// A piece tagged into stock, or changed while it is in the shop.
export function PieceForm({ biz, settings, items, piece, onClose, onSaved }) {
  const editing = Boolean(piece);
  const money = biz.can("sales.view");
  const canBringIn = biz.can("inventory.edit");
  const active = items.filter((i) => i.active);
  const locations = biz.locations.filter((l) => l.active);
  const itemOf = (skuId) => items.find((i) => String(i.sku_id) === String(skuId)) || null;
  const fromItem = (item) => ({ purity: item ? purityKey(item.metal, item.purity) : "gold:22K", wastage: item ? String(item.wastage_percent ?? "0") : "0",
    makingMode: item?.making_mode || "per_gram", makingValue: item ? String(item.making_value ?? "0") : "0" });
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => (editing ? {
    description: piece.description || "", purity: purityKey(piece.metal, piece.purity), gross: Number(piece.gross_weight).toFixed(3), stone: Number(piece.stone_weight).toFixed(3),
    wastage: piece.wastage_percent ?? "", makingMode: piece.making_mode, makingValue: piece.making_value ?? "", hallmarked: piece.hallmarked, oldHallmark: piece.old_hallmark,
    hallmarkCharge: piece.hallmark_charge ?? "", huids: (piece.huid_list || []).join(" "), exemption: piece.exemption || "", notes: piece.notes || "", designCode: piece.design_code || "",
    stones: piece.stones.map((s) => ({ key: newKey(), kind: s.kind, description: s.description || "", pieces: String(s.pieces), carat: s.carat ? String(Number(s.carat)) : "",
      grade: s.grade || "", certificate: s.certificate || "", treatment: s.treatment || "", value: s.value === null ? "" : String(Number(s.value)) })),
  } : {
    skuId: String(active[0]?.sku_id || ""), comesIn: canBringIn ? "new" : "stock", locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""),
    reason: "opening", cost: "", tagNo: "", description: "", gross: "", stone: "", ...fromItem(active[0]), hallmarked: false, oldHallmark: false, hallmarkCharge: settings.hallmarkCharge ?? "",
    huids: "", exemption: "", notes: "", designCode: "", stones: [],
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const chooseItem = (e) => { const next = e.target.value; setForm((f) => ({ ...f, skuId: next, ...fromItem(itemOf(next)) })); };
  const setStone = (key, change) => setForm((f) => ({ ...f, stones: f.stones.map((s) => (s.key === key ? { ...s, ...change } : s)) }));
  const { metal } = splitKey(form.purity);
  const net = netOf(form.gross, form.stone);
  const submit = () => {
    const figures = {
      description: form.description.trim() || null, ...splitKey(form.purity), grossWeight: form.gross, stoneWeight: form.stone || "0", makingMode: form.makingMode,
      hallmarked: form.hallmarked, oldHallmark: form.hallmarked && form.oldHallmark, huids: form.hallmarked && !form.oldHallmark ? readHuids(form.huids) : [],
      exemption: metal === "gold" ? form.exemption || null : null, notes: form.notes.trim() || null, designCode: form.designCode.trim() || null,
      ...(money ? { wastagePercent: form.wastage || "0", makingValue: form.makingValue || "0", hallmarkCharge: form.hallmarked ? form.hallmarkCharge || "0" : "0" } : {}),
      stones: form.stones.map((s) => ({ kind: s.kind, description: s.description.trim() || undefined, pieces: s.pieces || "1", carat: s.carat || undefined, grade: s.grade.trim() || undefined,
        certificate: s.certificate.trim() || undefined, treatment: s.treatment.trim() || undefined, ...(money ? { value: s.value || "0" } : {}) })),
    };
    if (editing) return businessWrite(biz.id, `jewellery/pieces/${piece.id}`, figures, "put");
    return businessWrite(biz.id, "jewellery/pieces", { requestKey, skuId: form.skuId, comesIn: form.comesIn, tagNo: form.tagNo.trim() || undefined,
      ...(form.comesIn === "new" ? { locationId: form.locationId, reason: form.reason, ...(form.cost ? { cost: form.cost } : {}) } : {}), ...figures });
  };
  if (!editing && !active.length) {
    return <FormDialog title="Tag a piece" icon="tag" onClose={onClose} onSubmit={() => {}} hideSubmit><p className="field-wide jw-note">Add a jewellery item first: the catalogue item its pieces are sold as.</p></FormDialog>;
  }
  return (
    <FormDialog title={editing ? `Piece ${piece.tag_no}` : "Tag a piece"} icon="tag" width={860} onClose={onClose} onSubmit={submit} onSaved={onSaved}
      submitLabel={editing ? "Save the piece" : "Tag the piece"} successMessage={(p) => (editing ? "Piece saved." : `Piece ${p.tag_no} tagged.`)}
      description={editing ? "What is weighed, charged and marked on it; its item and tag stay." : "Weights to the milligram: the net weight is the gross weight less the stones."}>
      {!editing && (
        <>
          <Field label="Item"><select required value={form.skuId} onChange={chooseItem}>{active.map((i) => <option key={i.sku_id} value={i.sku_id}>{i.label}</option>)}</select></Field>
          <Field label="It comes in">
            <select value={form.comesIn} onChange={set("comesIn")}>
              {canBringIn && <option value="new">Into stock now, with its tag</option>}
              <option value="stock">A unit already in stock (bought with its number)</option>
            </select>
          </Field>
          {form.comesIn === "new" ? (
            <>
              {locations.length > 1 && <Field label="At"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
              <Field label="Why it comes in"><select value={form.reason} onChange={set("reason")}>{(settings.comesIn || []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
              <Field label="Cost (optional)" hint="What the piece cost the shop, for the stock value."><input type="number" min="0" step="0.01" value={form.cost} onChange={set("cost")} /></Field>
              <Field label="Tag (optional)" hint={`Empty: the next number (${settings.nextTag}).`}><input maxLength={20} className="mono" value={form.tagNo} onChange={set("tagNo")} /></Field>
            </>
          ) : (
            <Field label="Its number in stock" hint="The serial number it was received under: it becomes its tag."><input required maxLength={20} className="mono" value={form.tagNo} onChange={set("tagNo")} /></Field>
          )}
        </>
      )}
      <Field label="Words on the bill (optional)" wide hint="Empty: the item's name."><input maxLength={150} value={form.description} onChange={set("description")} placeholder="e.g. Bridal necklace with rubies" /></Field>
      <Field label="Metal and purity"><select value={form.purity} onChange={set("purity")}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <Field label="Gross weight (g)"><input required type="number" min="0.001" step="0.001" inputMode="decimal" value={form.gross} onChange={set("gross")} /></Field>
      <Field label="Stones, beads and thread (g)"><input type="number" min="0" step="0.001" inputMode="decimal" value={form.stone} onChange={set("stone")} /></Field>
      <Field label="Net weight"><output className="jw-output">{net ? grams(net) : "—"}</output></Field>
      <Field label="Making charge"><select value={form.makingMode} onChange={set("makingMode")}>{MAKING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
      {money && (
        <>
          <Field label={form.makingMode === "percent" ? "Making (% of the metal's value)" : form.makingMode === "flat" ? "Making (₹ for the piece)" : "Making (₹ a gram)"}>
            <input type="number" min="0" step="0.01" value={form.makingValue} onChange={set("makingValue")} />
          </Field>
          <Field label="Wastage (% of the net weight)"><input type="number" min="0" max="100" step="0.01" value={form.wastage} onChange={set("wastage")} /></Field>
        </>
      )}
      <Field label="Design code (optional)"><input className="mono" maxLength={40} value={form.designCode} onChange={(e) => setForm((f) => ({ ...f, designCode: e.target.value.toUpperCase() }))} placeholder="e.g. NK-2041" /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={form.hallmarked} onChange={set("hallmarked")} /> Hallmarked by BIS</label>
      {form.hallmarked && (
        <>
          <label className="checkbox bz-check"><input type="checkbox" checked={form.oldHallmark} onChange={set("oldHallmark")} /> The old hallmark, without a HUID: to be re-hallmarked</label>
          {!form.oldHallmark && <Field label="HUIDs" hint="The 6 letters and digits of each hallmark; a set may carry several."><input className="mono" value={form.huids} onChange={set("huids")} placeholder="AB12C3" /></Field>}
          {money && <Field label="Hallmarking charge (₹)"><input type="number" min="0" step="0.01" value={form.hallmarkCharge} onChange={set("hallmarkCharge")} /></Field>}
        </>
      )}
      {metal === "gold" && (
        <Field label="Left out of mandatory hallmarking" wide hint="Only when the hallmarking order leaves this article out.">
          <select value={form.exemption} onChange={set("exemption")}><option value="">No: hallmarked where hallmarking is mandatory</option>
            {(settings.exemptions || []).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
        </Field>
      )}
      <div className="field-wide">
        <div className="jw-stones-head"><strong>Stones</strong><button type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, stones: [...f.stones, blankStone()] }))}><Icon name="plus" size={13} /> Add a stone</button></div>
        {form.stones.length === 0 ? <p className="muted small">No stones.</p> : (
          <table className="jw-stones">
            <thead><tr><th scope="col">Kind</th><th scope="col">How many</th><th scope="col">Carats</th><th scope="col">Colour, clarity, cut</th><th scope="col">Certificate</th><th scope="col">Treatment</th>{money && <th scope="col">Value (₹)</th>}<th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>
              {form.stones.map((s) => (
                <tr key={s.key}>
                  <td><select aria-label="Kind of stone" value={s.kind} onChange={(e) => setStone(s.key, { kind: e.target.value })}>{(settings.stoneKinds || []).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></td>
                  <td><input aria-label="How many" type="number" min="1" step="1" value={s.pieces} onChange={(e) => setStone(s.key, { pieces: e.target.value })} /></td>
                  <td><input aria-label="Carats" type="number" min="0.001" step="0.001" value={s.carat} onChange={(e) => setStone(s.key, { carat: e.target.value })} /></td>
                  <td><input aria-label="Colour, clarity and cut" maxLength={80} value={s.grade} onChange={(e) => setStone(s.key, { grade: e.target.value })} /></td>
                  <td><input aria-label="Certificate" maxLength={80} value={s.certificate} onChange={(e) => setStone(s.key, { certificate: e.target.value })} /></td>
                  <td><input aria-label="Treatment" maxLength={150} value={s.treatment} onChange={(e) => setStone(s.key, { treatment: e.target.value })} /></td>
                  {money && <td><input aria-label="Value" type="number" min="0" step="0.01" value={s.value} onChange={(e) => setStone(s.key, { value: e.target.value })} /></td>}
                  <td><button type="button" className="link-button danger" onClick={() => setForm((f) => ({ ...f, stones: f.stones.filter((x) => x.key !== s.key) }))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">A diamond alone is a natural one; call a man-made one a laboratory-grown diamond.</p>
      </div>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// A piece split into its articles: the weights come to the piece's own, each HUID and stone line goes with one of them.
const blankPart = () => ({ key: newKey(), tagNo: "", description: "", gross: "", stone: "", huids: "", stones: [] });
function SplitForm({ biz, piece, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [parts, setParts] = useState(() => [blankPart(), blankPart()]);
  const setPart = (key, change) => setParts((all) => all.map((p) => (p.key === key ? { ...p, ...change } : p)));
  const toggleStone = (key, seq) => setParts((all) => all.map((p) => (p.key === key ? { ...p, stones: p.stones.includes(seq) ? p.stones.filter((s) => s !== seq) : [...p.stones, seq] } : p)));
  const mg = (value) => Math.round(Number(value || 0) * 1000);
  const gross = parts.reduce((s, p) => s + mg(p.gross), 0), stone = parts.reduce((s, p) => s + mg(p.stone), 0);
  return (
    <FormDialog title={`Split piece ${piece.tag_no}`} icon="layers" width={900} onClose={onClose} onSaved={onSaved} submitLabel="Split it"
      successMessage={(r) => `Split into ${r.pieces.map((p) => p.tag_no).join(", ")}.`}
      description={`A set into its articles: the pieces come to its ${grams(piece.gross_weight)} gross and ${grams(piece.stone_weight)} of stones, its cost is shared by net weight, and each HUID and stone goes with its article. Each gets a tag of its own.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/pieces/${piece.id}/split`, { requestKey, parts: parts.map((p) => ({ tagNo: p.tagNo.trim() || undefined, description: p.description.trim() || undefined,
        grossWeight: p.gross, stoneWeight: p.stone || "0", huids: readHuids(p.huids), stones: p.stones })) })}>
      <div className="field-wide jw-og-lines">
        {parts.map((p, index) => (
          <fieldset key={p.key} className="jw-og-line">
            <legend>Piece {index + 1}</legend>
            <div className="jw-row">
              <Field label="Tag (optional)" hint="Empty: the next number."><input className="mono" maxLength={20} value={p.tagNo} onChange={(e) => setPart(p.key, { tagNo: e.target.value.toUpperCase() })} /></Field>
              <Field label="Words on the bill (optional)"><input maxLength={150} value={p.description} onChange={(e) => setPart(p.key, { description: e.target.value })} /></Field>
              <Field label="Gross weight (g)"><input required type="number" min="0.001" step="0.001" value={p.gross} onChange={(e) => setPart(p.key, { gross: e.target.value })} /></Field>
              <Field label="Stones (g)"><input type="number" min="0" step="0.001" value={p.stone} onChange={(e) => setPart(p.key, { stone: e.target.value })} /></Field>
            </div>
            {(piece.huid_list.length > 0 || piece.stones.length > 0) && (
              <div className="jw-row">
                {piece.huid_list.length > 0 && <Field label="Its HUIDs" hint={`Of ${piece.huid_list.join(", ")}`}><input className="mono" value={p.huids} onChange={(e) => setPart(p.key, { huids: e.target.value })} /></Field>}
                {piece.stones.map((s) => <label key={s.seq} className="checkbox bz-check"><input type="checkbox" checked={p.stones.includes(Number(s.seq))} onChange={() => toggleStone(p.key, Number(s.seq))} /> {s.kind_words}{s.carat ? ` ${Number(s.carat).toFixed(3)} ct` : ""}</label>)}
              </div>
            )}
            {parts.length > 2 && <button type="button" className="link-button danger" onClick={() => setParts((all) => all.filter((x) => x.key !== p.key))}>Remove</button>}
          </fieldset>
        ))}
        {parts.length < 10 && <button type="button" className="chip-button" onClick={() => setParts((all) => [...all, blankPart()])}><Icon name="plus" size={13} /> Another piece</button>}
        <p className={gross === mg(piece.gross_weight) && stone === mg(piece.stone_weight) ? "muted small" : "bz-due small"}>
          The pieces come to {grams(gross / 1000)} gross ({grams(stone / 1000)} stones); the piece is {grams(piece.gross_weight)} ({grams(piece.stone_weight)} stones).</p>
      </div>
    </FormDialog>
  );
}

// A piece given a new tag (after a repair, or a tag worn out): the same piece in every figure.
function RetagForm({ biz, piece, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [tagNo, setTagNo] = useState("");
  return (
    <FormDialog title={`A new tag for piece ${piece.tag_no}`} icon="tag" onClose={onClose} onSaved={onSaved} submitLabel="Give the new tag" successMessage={(p) => `Piece ${p.tag_no}: its new tag.`}
      description="Its weights, charges, HUIDs, stones, cost, photo and custom order go to the new tag; the old tag is retired and kept in its history."
      onSubmit={() => businessWrite(biz.id, `jewellery/pieces/${piece.id}/retag`, { requestKey, tagNo: tagNo.trim() || undefined })}>
      <Field label="New tag (optional)" hint="Empty: the next number."><input className="mono" maxLength={20} value={tagNo} onChange={(e) => setTagNo(e.target.value.toUpperCase())} /></Field>
    </FormDialog>
  );
}

// Several pieces merged into one (articles made a set): one purity, one location; weights, HUIDs, stones and cost added up.
export function MergeForm({ biz, items, onClose, onSaved }) {
  const money = biz.can("sales.view");
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ tags: "", tagNo: "", description: "", skuId: "", makingMode: "", makingValue: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Merge pieces into one" icon="layers" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Merge them" successMessage={(p) => `Merged into ${p.tag_no}.`}
      description="Pieces of one metal and purity at one location become one piece: their weights, HUIDs, stones and cost added up, through the stock (each unit out with its reason, the new one in)."
      onSubmit={() => businessWrite(biz.id, "jewellery/pieces/merge", { requestKey, tags: readTags(form.tags), tagNo: form.tagNo.trim() || undefined, description: form.description.trim() || undefined,
        skuId: form.skuId || undefined, ...(money && form.makingMode ? { makingMode: form.makingMode, makingValue: form.makingValue || "0" } : {}) })}>
      <Field label="Tags of the pieces" wide hint="2 to 10, with spaces or new lines between them."><textarea required rows={3} className="mono" value={form.tags} onChange={set("tags")} /></Field>
      <Field label="Its tag (optional)" hint="Empty: the next number."><input className="mono" maxLength={20} value={form.tagNo} onChange={(e) => setForm((f) => ({ ...f, tagNo: e.target.value.toUpperCase() }))} /></Field>
      <Field label="Words on the bill (optional)"><input maxLength={150} value={form.description} onChange={set("description")} placeholder="e.g. Bridal set" /></Field>
      <Field label="Item (optional)" hint="Empty: the first piece's item."><select value={form.skuId} onChange={set("skuId")}><option value="">As the first piece</option>{items.filter((i) => i.active).map((i) => <option key={i.sku_id} value={i.sku_id}>{i.label}</option>)}</select></Field>
      {money && (
        <>
          <Field label="Making charge (optional)" hint="Needed when the pieces are charged differently."><select value={form.makingMode} onChange={set("makingMode")}><option value="">As the pieces</option>{MAKING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
          {form.makingMode && <Field label="Making"><input type="number" min="0" step="0.01" value={form.makingValue} onChange={set("makingValue")} /></Field>}
        </>
      )}
    </FormDialog>
  );
}

function MeltForm({ biz, piece, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Melt piece ${piece.tag_no}`} icon="alert" onClose={onClose} onSaved={onSaved} submitLabel="Melt it" successMessage="Melted."
      onSubmit={() => businessWrite(biz.id, `jewellery/pieces/${piece.id}/melt`, { requestKey, reason: reason.trim() })}
      description={`Its unit leaves stock for good, and its ${grams(piece.net_weight)} of ${purityWords(piece.metal, piece.purity)} joins the shop's metal for melting and refining.`}>
      <Field label="Why" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Broken beyond repair; to be remade" /></Field>
    </FormDialog>
  );
}

// A piece's panel: what it is, its price at today's rate, its history and what can be done with it.
export function PiecePanel({ biz, pieceId, settings, items, onClose, onChanged, onOpen }) {
  const [piece, setPiece] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [layout, setLayout] = useState("roll");
  useEffect(() => {
    if (!pieceId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/pieces/${pieceId}`, undefined, controller.signal).then((p) => { setPiece(p); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, pieceId, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); onChanged?.(); };
  const open = piece && OPEN_STATUSES.includes(piece.status);
  const money = piece?.money !== false;
  const facts = useMemo(() => {
    if (!piece) return [];
    return [
      ["Item", piece.item_label], ["Purity", piece.purity_words], ["Gross weight", grams(piece.gross_weight)], ["Stones, beads, thread", grams(piece.stone_weight)],
      ["Net weight", grams(piece.net_weight)],
      ["Making", money ? makingWords(biz, piece.making_mode, piece.making_value) : null], ["Wastage", money ? `${Number(piece.wastage_percent)}% of the net weight` : null],
      ["Hallmark", piece.hallmarked ? `Hallmarked${piece.huids ? ` · HUID ${piece.huids}` : piece.old_hallmark ? " · the old hallmark: to be re-hallmarked" : " · no HUID yet"}${money && Number(piece.hallmark_charge) ? ` · charge ${biz.exact(piece.hallmark_charge)}` : ""}` : "Not hallmarked"],
      ["Left out of hallmarking", piece.exemption_words], ["Design code", piece.design_code], ["Custom order", piece.order_no],
      ["Where", piece.location_name || (piece.status === "sold" ? "Sold" : OPEN_STATUSES.includes(piece.status) ? "Not in stock in the books" : PIECE_STATUSES[piece.status]?.label)],
      ["Out on", piece.out_no ? `${piece.out_no} · ${piece.out_with}${piece.out_due ? ` · due back ${piece.out_due}` : ""}` : null],
      ["Made from", piece.made_from.length ? piece.made_from.map((m) => m.tag).join(", ") : null], ["Made into", piece.made_into.length ? piece.made_into.map((m) => m.tag).join(", ") : null],
      ["Notes", piece.notes],
    ].filter(([, value]) => value);
  }, [piece, money, biz]);
  const inStock = piece?.status === "in_stock" && piece?.in_books;
  const reshape = inStock && biz.can("jewellery.edit") && biz.can("inventory.edit");
  return (
    <SidePanel open title={piece ? `Piece ${piece.tag_no}` : "Piece"} icon="tag" wide onClose={onClose}
      footer={piece && (
        <div className="jw-panel-actions">
          {open && biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "edit" })}><Icon name="edit" size={15} /> Change</button>}
          {inStock && biz.can("jewellery.edit") && biz.can("sales.view") && <Link className="button button-secondary" to={`${biz.path("approvals")}?send=${piece.tag_no}`}>On approval</Link>}
          {inStock && biz.can("jewellery.edit") && <Link className="button button-secondary" to={`${biz.path("karigar-work")}?issue=${piece.tag_no}`}>To a karigar</Link>}
          {inStock && ["gold", "silver"].includes(piece.metal) && biz.can("jewellery.edit") && <Link className="button button-secondary" to={`${biz.path("hallmarking")}?send=${piece.tag_no}`}>For hallmarking</Link>}
          {piece.out_kind && <Link className="button" to={`${biz.path(OUT_SCREENS[piece.out_kind].screen)}?${OUT_SCREENS[piece.out_kind].param}=${piece.out_id}`}>{piece.out_kind === "karigar" ? "Receive it back" : "Open its challan"}</Link>}
          {reshape && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "split" })}>Split</button>}
          {reshape && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "retag" })}>A new tag</button>}
          {open && biz.can("jewellery.print") && (
            <span className="jw-print">
              <select aria-label="Tag layout" value={layout} onChange={(e) => setLayout(e.target.value)}>{Object.entries(TAG_LAYOUTS).map(([value, l]) => <option key={value} value={value}>{l.label}</option>)}</select>
              <button type="button" className="button button-secondary" onClick={() => printPieceTags(biz, [piece], layout)}><Icon name="print" size={15} /> Print the tag</button>
            </span>
          )}
          {piece.status === "in_stock" && piece.in_books && biz.can("jewellery.approve") && <button type="button" className="button button-secondary danger" onClick={() => setDialog({ kind: "melt" })}>Melt</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!piece ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head">
            <Badge tone={PIECE_STATUSES[piece.status]?.tone} label={PIECE_STATUSES[piece.status]?.label || piece.status} />
            <strong>{piece.description || piece.item_label}</strong>
            {!piece.in_books && open && <span className="jw-note jw-warn">Its unit is not in stock in the books (a stock count wrote it off?): it cannot be billed.</span>}
          </div>
          <div className="jw-row jw-order-top">
            <dl className="jw-facts jw-grow">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            <JewelleryPhoto biz={biz} fileId={piece.photo_id} pieceId={piece.id} canChange={open && biz.can("jewellery.edit")} onChanged={done} />
          </div>
          {piece.stones.length > 0 && (
            <table className="jw-rates">
              <thead><tr><th scope="col">Stone</th><th scope="col">How many</th><th scope="col">Carats</th><th scope="col">Grade · certificate</th>{money && <th scope="col">Value</th>}</tr></thead>
              <tbody>{piece.stones.map((s) => (
                <tr key={s.seq}><td>{s.kind_words}{s.treatment ? <small className="muted"> · {s.treatment}</small> : null}</td><td>{s.pieces}</td><td>{s.carat ? Number(s.carat).toFixed(3) : "—"}</td>
                  <td>{[s.grade, s.certificate].filter(Boolean).join(" · ") || "—"}</td>{money && <td>{biz.exact(s.value)}</td>}</tr>
              ))}</tbody>
            </table>
          )}
          {money && open && (piece.price ? (
            <div className="jw-price">
              <strong>Price at today's rate ({perGram(biz, piece.price.rate)})</strong>
              <span>Metal {biz.exact(piece.price.metal)}</span>
              {Number(piece.price.wastage) > 0 && <span>Wastage {grams(piece.price.wastageWeight)} · {biz.exact(piece.price.wastage)}</span>}
              <span>Making {biz.exact(piece.price.making)}</span>
              {Number(piece.price.stones) > 0 && <span>Stones {biz.exact(piece.price.stones)}</span>}
              {Number(piece.price.hallmark) > 0 && <span>Hallmarking {biz.exact(piece.price.hallmark)}</span>}
              <span>Before GST {biz.exact(piece.price.value)} · GST {Number(piece.price.taxRate)}% {biz.exact(piece.price.tax)}</span>
              <strong>{biz.exact(piece.price.total)}</strong>
            </div>
          ) : <p className="jw-note">{purityWords(piece.metal, piece.purity)} has no rate today: set today's rates to price it.</p>)}
          <section>
            <h3 className="jw-subhead">History</h3>
            <ol className="jw-history">{piece.events.map((e) => <li key={e.id}><span>{dateTime(e.created_at)} · {e.by_name}</span><span>{e.note || e.kind}</span></li>)}</ol>
          </section>
        </div>
      )}
      {dialog?.kind === "edit" && <PieceForm biz={biz} settings={settings} items={items} piece={piece} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "split" && <SplitForm biz={biz} piece={piece} onClose={() => setDialog(null)} onSaved={(r) => { setDialog(null); onChanged?.(); onOpen?.(r.pieces[0].id); }} />}
      {dialog?.kind === "retag" && <RetagForm biz={biz} piece={piece} onClose={() => setDialog(null)} onSaved={(p) => { setDialog(null); onChanged?.(); onOpen?.(p.id); }} />}
      {dialog?.kind === "melt" && <MeltForm biz={biz} piece={piece} onClose={() => setDialog(null)} onSaved={done} />}
    </SidePanel>
  );
}
