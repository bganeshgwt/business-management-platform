import { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { PIECE_STATUSES, grams, makingWords, purityMark } from "./jewellery";
import { ItemForm, MergeForm, PieceForm, PiecePanel } from "./PieceDialogs";
import { TAG_LAYOUTS, printPieceTags } from "./jewelleryPrint";
import "../styles/jewellery.css";

// Pieces & tags: every tagged piece by its tag, item, purity and weights,
// its stones and HUIDs, where it is and what it is doing (in stock, on
// approval, at a karigar, at the hallmarking centre, sold, melted, split,
// merged or given a new tag). A piece is found by its tag or a HUID; it opens
// in a panel with its photo, its price at today's rate and its history.
// Below: the jewellery items (what a new piece of each starts with) and the
// shop's own metal. No prices or charges for a role that does not see sales.

const CHIPS = [
  ["in", "In the shop", { stage: "in" }], ["in_stock", "In stock", { status: "in_stock" }], ["on_approval", "On approval", { status: "on_approval" }],
  ["at_karigar", "At a karigar", { status: "at_karigar" }], ["at_centre", "At the centre", { status: "at_centre" }], ["unmarked", "Not hallmarked", { stage: "in", hallmarked: "false" }],
  ["old_mark", "To re-hallmark", { stage: "in", old_hallmark: "true" }], ["missing", "Not in the books", { stage: "in", in_books: "false" }], ["sold", "Sold", { status: "sold" }],
  ["melted", "Melted", { status: "melted" }], ["all", "All", {}],
];

export default function PiecesPage() {
  const biz = useOpenBusiness();
  const [chip, setChip] = useState("in");
  const [settings, setSettings] = useState(null);
  const [items, setItems] = useState(null);
  const [metal, setMetal] = useState([]);
  const [catalogue, setCatalogue] = useState([]);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [layout, setLayout] = useState("roll");
  const [version, setVersion] = useState(0);
  const params = useMemo(() => CHIPS.find(([value]) => value === chip)?.[2] || {}, [chip]);
  const list = useServerList("jewellery/pieces", { gridId: "jewellery-pieces", params });
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([businessRead(biz.id, "jewellery/settings", undefined, signal), businessRead(biz.id, "jewellery/items", undefined, signal),
      businessRead(biz.id, "jewellery/metal", undefined, signal)])
      .then(([s, i, m]) => { setSettings(s); setItems(i.items); setMetal(m); setError(""); })
      .catch((err) => { if (!signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  // Catalogue items that could become jewellery items: goods with serial numbers at 3% GST, not jewellery items yet.
  const openItemForm = async (item) => {
    if (!item && biz.can("catalog.edit")) {
      try {
        const page = await businessRead(biz.id, "catalog", { kind: "goods", active: "true", limit: 100 });
        const taken = new Set((items || []).map((i) => String(i.sku_id)));
        setCatalogue(page.items.filter((s) => s.tracking === "serial" && Number(s.tax_rate) === 3 && !taken.has(String(s.id))));
      } catch { setCatalogue([]); }
    }
    setDialog({ kind: "item", item });
  };
  const reload = useCallback(() => { setVersion((n) => n + 1); list.reload(); }, [list]);

  const columns = useMemo(() => [
    { key: "tag_no", header: "Tag", value: (p) => p.tag_no, className: "mono", mobile: "title", pin: true },
    { key: "item", header: "Piece", value: (p) => `${p.description || ""} ${p.item_label}`, mobile: "subtitle",
      render: (p) => <span className="bz-two-line"><span>{p.description || p.item_label}</span>{p.description && <small className="muted">{p.item_label}</small>}</span> },
    { key: "purity", header: "Purity", value: (p) => purityMark(p.metal, p.purity), mobile: "show" },
    { key: "gross_weight", header: "Gross", value: (p) => Number(p.gross_weight), render: (p) => grams(p.gross_weight), total: "sum" },
    { key: "net_weight", header: "Net", value: (p) => Number(p.net_weight), render: (p) => grams(p.net_weight), total: "sum", mobile: "show" },
    { key: "stones", header: "Stones", value: (p) => Number(p.stone_carat || 0),
      render: (p) => (p.stone_lines ? <span>{p.stone_lines} {p.stone_lines === 1 ? "line" : "lines"}{Number(p.stone_carat) ? ` · ${Number(p.stone_carat).toFixed(3)} ct` : ""}</span> : <span className="muted">—</span>) },
    { key: "huids", header: "HUID", value: (p) => p.huids || "", render: (p) => (p.huids ? <span className="mono">{p.huids}</span> : p.hallmarked ? <span className="bz-minus">Hallmarked, no HUID</span> : <span className="muted">Not hallmarked</span>) },
    money && { key: "making", header: "Making", value: (p) => makingWords(biz, p.making_mode, p.making_value), defaultHidden: true },
    { key: "status", header: "Status", type: "status", value: (p) => PIECE_STATUSES[p.status]?.label || p.status, mobile: "show",
      render: (p) => <span className="bz-two-line"><Badge tone={PIECE_STATUSES[p.status]?.tone} label={PIECE_STATUSES[p.status]?.label || p.status} />
        {(p.out_no || (!p.in_books && p.stage === "in")) && <small className={p.in_books ? "muted" : "bz-minus"}>{p.in_books ? `${p.out_no} · ${p.out_with}` : "not in stock in the books"}</small>}</span> },
    { key: "design_code", header: "Design", value: (p) => p.design_code || "", className: "mono", defaultHidden: true },
    { key: "order", header: "Order", value: (p) => p.order_no || "", defaultHidden: true },
    { key: "location", header: "Location", value: (p) => p.location_name || "", defaultHidden: !many },
    { key: "created_at", header: "Tagged", type: "datetime", value: (p) => p.created_at, defaultHidden: true },
  ].filter(Boolean), [biz, money, many]);

  if (!settings || !items) return <div className="stack"><BusinessHeader icon="tag" title="Pieces & tags" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const shown = list.data?.items || [];
  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Pieces & tags"
        description="Each piece is a serial-numbered unit of its jewellery item, its tag the number: weighed to the milligram, priced by the day's rate when it is billed."
        primary={biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => setDialog({ kind: "piece" })}><Icon name="plus" size={16} /> Tag a piece</button>}
        secondary={<>
          {biz.can("jewellery.edit") && biz.can("inventory.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "merge" })}><Icon name="layers" size={15} /> Merge pieces</button>}
          {biz.can("jewellery.print") && shown.length > 0 && (
            <span className="jw-print">
              <select aria-label="Tag layout" value={layout} onChange={(e) => setLayout(e.target.value)}>{Object.entries(TAG_LAYOUTS).map(([value, l]) => <option key={value} value={value}>{l.label}</option>)}</select>
              <button type="button" className="button button-secondary" onClick={() => printPieceTags(biz, shown.filter((p) => p.stage === "in"), layout)}><Icon name="print" size={15} /> Print these tags</button>
            </span>
          )}
        </>} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="tag" title="Pieces">
        <div className="fe-chips" role="group" aria-label="Pieces">
          {CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Tag, HUID, item or words" }} caption="Pieces" columns={columns} rowNoun={["piece", "pieces"]}
          onRowClick={(p) => setOpenId(p.id)} rowClassName={(p) => (!p.in_books && p.stage === "in" ? "dg-tone-danger" : p.stage === "out" ? "dg-tone-muted" : "")}
          empty="No pieces here" emptyHint={biz.can("jewellery.edit") ? "Tag one with Tag a piece." : undefined} emptyIcon="tag" />
      </SectionCard>
      <SectionCard icon="layers" title="Jewellery items" description="The catalogue items sold as tagged pieces, at 3% GST, and what a new piece of each starts with."
        actions={biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => openItemForm(null)}><Icon name="plus" size={15} /> A jewellery item</button>}>
        {items.length === 0 ? <p className="jw-note">No jewellery items yet: add one (a gold necklace, a silver anklet) before tagging its pieces.</p> : (
          <table className="jw-rates">
            <thead><tr><th scope="col">Item</th><th scope="col">Starts as</th>{money && <th scope="col">Making · wastage</th>}<th scope="col">In the shop</th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.sku_id}>
                <th scope="row">{biz.can("jewellery.edit") ? <button type="button" className="link-button" onClick={() => openItemForm(i)}>{i.label}</button> : i.label}
                  <small className="muted"> {i.code}{i.hsn_code ? ` · HSN ${i.hsn_code}` : ""}{i.active ? "" : " · switched off"}</small></th>
                <td>{purityMark(i.metal, i.purity)}</td>
                {money && <td>{makingWords(biz, i.making_mode, i.making_value)}{Number(i.wastage_percent) ? ` · wastage ${Number(i.wastage_percent)}%` : ""}</td>}
                <td>{i.pieces}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </SectionCard>
      {metal.length > 0 && (
        <SectionCard icon="scale" title="The shop's own metal" description="By purity: melted pieces, old gold, scrap back from karigars and metal from suppliers, for karigars' work, melting and refining; never billed.">
          <table className="jw-rates">
            <thead><tr><th scope="col">Purity</th>{many && <th scope="col">Location</th>}<th scope="col">Metal</th><th scope="col">Fine metal</th></tr></thead>
            <tbody>{metal.map((m) => <tr key={`${m.location_id}:${m.metal}:${m.purity}`}><th scope="row">{m.label}</th>{many && <td>{m.location_name}</td>}<td>{grams(m.net_weight)}</td><td>{grams(m.fine_weight)}</td></tr>)}</tbody>
          </table>
        </SectionCard>
      )}
      {dialog?.kind === "piece" && <PieceForm biz={biz} settings={settings} items={items} onClose={() => setDialog(null)} onSaved={(p) => { setDialog(null); reload(); setOpenId(p.id); }} />}
      {dialog?.kind === "item" && <ItemForm biz={biz} item={dialog.item} catalogue={catalogue} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }} />}
      {dialog?.kind === "merge" && <MergeForm biz={biz} items={items} onClose={() => setDialog(null)} onSaved={(p) => { setDialog(null); reload(); setOpenId(p.id); }} />}
      {openId && <PiecePanel key={openId} biz={biz} pieceId={openId} settings={settings} items={items} onClose={() => setOpenId(null)} onChanged={reload} onOpen={setOpenId} />}
    </div>
  );
}
