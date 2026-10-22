import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getMenuCard } from "../services/menu.service";
import { listOutlets } from "../../../../services/outlet.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "@bmp/shared/format";
import { printMenuCard } from "./menuCardDocument";
import "../../../../styles/backoffice-sweep.css";

// Menu → Products → Print menu (sweep SW-B-20): pick an outlet and a service,
// see what goes on the card, print it at A4. The prices are the ones that
// outlet and service charge at the till; dishes off the menu or not sold
// there are left out (the count says how many).

const SERVICES = [
  { key: "dine_in", label: "Dine-in" },
  { key: "takeaway", label: "Takeaway" },
  { key: "delivery", label: "Delivery" },
];

export default function PrintMenuModal({ onClose }) {
  const [outlets, setOutlets] = useState([]);
  const [outletId, setOutletId] = useState("");
  const [orderType, setOrderType] = useState("dine_in");
  const [descriptions, setDescriptions] = useState(true);
  const [addOns, setAddOns] = useState(false);
  const [codes, setCodes] = useState(false);
  const [card, setCard] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listOutlets()
      .then((rows) => setOutlets(rows.filter((row) => row.status === "active")))
      .catch(() => setOutlets([]));
  }, []);

  useEffect(() => {
    getMenuCard({ outletId: outletId || undefined, orderType })
      .then((result) => {
        setCard(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [outletId, orderType]);

  const withDescriptions = card ? card.categories.reduce((n, cat) => n + cat.items.filter((item) => item.description).length, 0) : 0;

  return (
    <Modal
      title="Print the menu"
      description="An A4 menu card for one outlet and one service, at the prices it charges."
      icon="print"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button"
            disabled={!card || loading || card.summary.items === 0}
            onClick={() => printMenuCard(card, { descriptions, addOns, codes })}
          >
            <Icon name="print" size={16} /> Print / PDF
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <label className="field">
            <span>Outlet</span>
            <select
              value={outletId}
              onChange={(event) => {
                setLoading(true);
                setOutletId(event.target.value);
              }}
            >
              <option value="">Restaurant prices (no outlet)</option>
              {outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span id="bo-menu-service">Service</span>
            <div className="segmented" role="radiogroup" aria-labelledby="bo-menu-service">
              {SERVICES.map((service) => (
                <button
                  type="button"
                  key={service.key}
                  role="radio"
                  aria-checked={orderType === service.key}
                  className={`segment ${orderType === service.key ? "is-active" : ""}`}
                  onClick={() => {
                    if (service.key !== orderType) {
                      setLoading(true);
                      setOrderType(service.key);
                    }
                  }}
                >
                  {service.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <fieldset className="field bo-menu-options">
          <legend>On the card</legend>
          <label className="checkbox">
            <input type="checkbox" checked={descriptions} onChange={(event) => setDescriptions(event.target.checked)} />
            <span>
              Dish descriptions <small className="muted">({count(withDescriptions)} dishes have one)</small>
            </span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={addOns} onChange={(event) => setAddOns(event.target.checked)} />
            <span>Add-ons and their prices</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={codes} onChange={(event) => setCodes(event.target.checked)} />
            <span>Short codes (for phone orders)</span>
          </label>
        </fieldset>

        <ErrorMessage message={error} />

        {loading && !card ? (
          <Loading label="Reading the menu…" />
        ) : card ? (
          <>
            <div className="stat-grid bo-menu-tiles">
              <StatTile size="sm" icon="list" tone="primary" label="Categories" value={count(card.summary.categories)} />
              <StatTile size="sm" icon="utensils" tone="success" label="Dishes on the card" value={count(card.summary.items)} />
              <StatTile
                size="sm"
                icon="ban"
                tone={card.summary.leftOut ? "warning" : "neutral"}
                label="Left out"
                value={count(card.summary.leftOut)}
                note="not sold here or for this service"
              />
            </div>
            <p className="muted small bo-menu-taxnote">
              <Icon name="info" size={14} /> Footer: “{card.taxNote}” The card carries the restaurant's name
              {card.restaurant.logo ? ", logo" : ""}, address{card.restaurant.fssai ? " and FSSAI number" : ""}.
              {!card.restaurant.fssai && " Add the FSSAI licence number under Settings to print it."}
            </p>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
