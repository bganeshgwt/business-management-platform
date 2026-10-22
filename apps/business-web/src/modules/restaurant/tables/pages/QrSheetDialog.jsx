import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { listTables } from "../services/table.service";
import { printDocument } from "../../../../services/print";
import { ADDRESS_WARNINGS, QR_LAYOUTS, addressProblem, buildQrSheet, guestBase, layoutOf, tablesForSheet } from "../../../../services/qrSheet";
import { count } from "@bmp/shared/format";
import { customerWebOrigin } from "../../../../services/customerWeb";

// "Print QR codes": every table's code on sheets, for all tables, one floor or
// one area, as A4 cards (4, 6 or 9 to a page) or a folded table tent. Each
// code opens its own table's guest page at the restaurant's guest ordering
// web address (services/qrSheet).
export default function QrSheetDialog({ floors, areas, qrSettings, canSetAddress, onClose }) {
  const [tables, setTables] = useState(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState("all");
  const [floorId, setFloorId] = useState(floors[0] ? String(floors[0].id) : "");
  const [areaId, setAreaId] = useState(areas[0] ? String(areas[0].id) : "");
  const [includeOff, setIncludeOff] = useState(false);
  const [layoutKey, setLayoutKey] = useState("a4-6");
  const [printing, setPrinting] = useState(false);

  // Every table, whatever floor the page behind is filtered to.
  useEffect(() => {
    listTables()
      .then(setTables)
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const configured = qrSettings ? qrSettings.guestWebAddress : null;
  const base = guestBase(configured, customerWebOrigin());
  const problem = addressProblem(configured, customerWebOrigin());
  const chosen = useMemo(
    () => tablesForSheet(tables, { scope, floorId, areaId, includeOff }),
    [tables, scope, floorId, areaId, includeOff]
  );
  const left = tables ? tablesForSheet(tables, { scope, floorId, areaId, includeOff: true }).length - chosen.length : 0;
  const layout = layoutOf(layoutKey);
  const pages = Math.ceil(chosen.length / layout.perPage);

  const print = async () => {
    setPrinting(true);
    setError("");

    try {
      const sheet = await buildQrSheet({
        tables: chosen,
        layoutKey,
        base,
        restaurantName: qrSettings ? qrSettings.restaurantName : "",
        // The receipt logo (a web address set in Settings), when there is one.
        logoUrl: qrSettings && qrSettings.logoPath ? qrSettings.logoPath : "",
      });

      printDocument({ title: sheet.title, styles: sheet.styles, body: sheet.body });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Modal title="Print table QR codes" icon="qr" onClose={onClose} width={720}>
      <div className="qrs">
        <ErrorMessage message={error} />

        {problem && (
          <div className={`alert ${problem === "local" ? "alert-danger" : "alert-notice"} qrs-warning`} role="alert">
            <p>{ADDRESS_WARNINGS[problem]}</p>
            {canSetAddress && (
              <Link to="/service/settings#guest-address" onClick={onClose}>
                Set the guest ordering web address
              </Link>
            )}
          </div>
        )}

        <p className="qrs-address muted small">
          Each code opens <span className="mono">{base}/order/…</span> for its own table.
        </p>

        <fieldset className="qrs-group">
          <legend>Which tables</legend>
          <div className="qrs-scope">
            <label className="qrs-option">
              <input type="radio" name="qrs-scope" checked={scope === "all"} onChange={() => setScope("all")} />
              <span>All tables</span>
            </label>
            <label className="qrs-option">
              <input
                type="radio"
                name="qrs-scope"
                checked={scope === "floor"}
                onChange={() => setScope("floor")}
                disabled={floors.length === 0}
              />
              <span>One floor</span>
            </label>
            <label className="qrs-option">
              <input
                type="radio"
                name="qrs-scope"
                checked={scope === "area"}
                onChange={() => setScope("area")}
                disabled={areas.length === 0}
              />
              <span>One area</span>
            </label>
          </div>
          {scope === "floor" && (
            <label className="field">
              <span>Floor</span>
              <select value={floorId} onChange={(event) => setFloorId(event.target.value)}>
                {floors.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {scope === "area" && (
            <label className="field">
              <span>Area</span>
              <select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.floorName ? `${area.floorName} · ` : ""}
                    {area.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="checkbox qrs-off">
            <input type="checkbox" checked={includeOff} onChange={(event) => setIncludeOff(event.target.checked)} />
            <span>Include tables that are out of service</span>
          </label>
        </fieldset>

        <fieldset className="qrs-group">
          <legend>Layout</legend>
          <div className="qrs-layouts" role="radiogroup" aria-label="Layout">
            {QR_LAYOUTS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={layoutKey === option.key}
                className={`qrs-layout ${layoutKey === option.key ? "is-active" : ""}`}
                onClick={() => setLayoutKey(option.key)}
              >
                <span
                  className={`qrs-preview qrs-preview-${option.key}`}
                  style={{ "--cols": option.columns, "--rows": option.rows }}
                  aria-hidden="true"
                >
                  {Array.from({ length: option.key === "tent" ? 2 : option.perPage }, (_, index) => (
                    <span key={index} />
                  ))}
                </span>
                <strong>{option.label}</strong>
                <small className="muted">{option.hint}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <p className="qrs-summary" aria-live="polite">
          {tables === null
            ? "Reading the tables…"
            : chosen.length === 0
              ? "No tables match. Choose another floor or area, or include tables out of service."
              : `${count(chosen.length)} ${chosen.length === 1 ? "table" : "tables"} on ${count(pages)} ${
                  pages === 1 ? "page" : "pages"
                }${left > 0 ? ` · ${count(left)} out of service left out` : ""}`}
        </p>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button" onClick={print} disabled={printing || chosen.length === 0}>
            <Icon name="print" size={16} /> {printing ? "Preparing…" : "Print"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
