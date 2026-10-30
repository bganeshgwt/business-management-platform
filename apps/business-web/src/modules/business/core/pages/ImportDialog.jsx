import { useState } from "react";
import SheetImportModal from "../../../../components/SheetImportModal";
import StatTile from "../../../../components/StatTile";
import api from "../../../../services/api";
import { businessRead } from "../../../../services/business.service";
import { count } from "@bmp/shared/format";
import { useOpenBusiness } from "./hooks";

// A shop's products, customers or suppliers from an Excel workbook (its first
// sheet, or the one chosen) or a CSV file: the app's one import screen with
// the shop's rules (businessImports.service.js on the server). A row with a
// problem is refused alone and the rest go in together;
// records already here are left as they are, or updated by someone who may
// change them and chooses to; the import carries a request key, so a retry
// after a lost answer is done once.
const KINDS = {
  products: {
    path: "catalog", one: "product", many: "products", edit: "catalog.edit", already: "Items already here",
    sample: "products-template.csv",
    description: "Your catalogue from another system or a spreadsheet: new items are added, and every row is checked first.",
    lead: "An item is found by its code, then its barcode. Opening stock goes in once, for an item with no stock on record yet, at its purchase price, as “Opening stock” in the stock movements. Rows of one style become one product with its variants; a pack size goes in with its unit and how many it holds.",
  },
  customer: {
    path: "contacts", one: "customer", many: "customers", edit: "contacts.edit", already: "Customers already here",
    sample: "customers-template.csv",
    description: "Your customers and what each owed when you started, from another system or your udhaar book: every row is checked first.",
    lead: "A customer is found by their GSTIN, then their phone, and with neither by their name. A phone is never needed. The opening balance is what they owed you when you started; it is set once.",
  },
  supplier: {
    path: "contacts", one: "supplier", many: "suppliers", edit: "contacts.edit", already: "Suppliers already here",
    sample: "suppliers-template.csv",
    description: "Your suppliers and what you owed each when you started, from another system or a spreadsheet: every row is checked first.",
    lead: "A supplier is found by their GSTIN, then their phone, and with neither by their name. The opening balance is what you owed them when you started; it is set once.",
  },
};

export default function ImportDialog({ kind, onClose, onImported }) {
  const biz = useOpenBusiness();
  const spec = KINDS[kind];
  const [mode, setMode] = useState("skip");
  const canUpdate = biz.can(spec.edit);
  const contact = kind !== "products";
  const query = contact ? { kind } : undefined;

  const choice = (value, text) => (
    <button type="button" role="radio" aria-checked={mode === value} className={`segment ${mode === value ? "is-active" : ""}`} onClick={() => setMode(value)}>
      {text}
    </button>
  );

  return (
    <SheetImportModal
      title="Import from Excel or CSV"
      description={spec.description}
      noun={spec.one}
      nounPlural={spec.many}
      sampleName={spec.sample}
      lead={spec.lead}
      partial
      requestKeys
      excel
      loadGuide={() => businessRead(biz.id, `${spec.path}/import-guide`, query)}
      runImport={(payload) => api.post(`/businesses/${biz.id}/${spec.path}/import`, { ...payload, ...query }).then((response) => response.data)}
      options={{ mode }}
      optionsControl={canUpdate && (
        <div className="field crm-import-mode">
          <span id={`import-mode-${kind}`}>{spec.already}</span>
          <div className="segmented" role="radiogroup" aria-labelledby={`import-mode-${kind}`}>
            {choice("skip", "Leave them as they are")}
            {choice("update", "Update them")}
          </div>
          <small className="muted">Updating changes only what the file gives: an empty cell keeps what is there.</small>
        </div>
      )}
      extraTiles={(check) => (
        <>
          {check.opening && check.opening.items > 0 && (
            <StatTile size="sm" icon="box" tone="primary" label="Opening stock" money={check.opening.value} currency={biz.symbol}
              note={`${count(check.opening.items)} ${check.opening.items === 1 ? "item" : "items"}`} />
          )}
          {check.newCategories && check.newCategories.length > 0 && (
            <StatTile size="sm" icon="layers" label="New categories" value={count(check.newCategories.length)} title={check.newCategories.join(", ")} />
          )}
          {check.styles && check.styles.count > 0 && (
            <StatTile size="sm" icon="layers" tone="primary" label="Styles" value={count(check.styles.count)}
              note={`${count(check.styles.variants)} new ${check.styles.variants === 1 ? "variant" : "variants"}`} />
          )}
          {check.packs > 0 && <StatTile size="sm" icon="box" label="Pack sizes" value={count(check.packs)} />}
          {check.balances && check.balances.count > 0 && (
            <StatTile size="sm" icon="wallet" tone="primary" label="Opening balances" money={check.balances.total} currency={biz.symbol}
              note={`${count(check.balances.count)} ${check.balances.count === 1 ? spec.one : spec.many}`} />
          )}
        </>
      )}
      describeRow={(row) => (contact ? row.hint : row.code) || null}
      onClose={onClose}
      onImported={onImported}
    />
  );
}
