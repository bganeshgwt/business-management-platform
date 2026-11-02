import { useId } from "react";
import Icon from "@bmp/ui/Icon";

// The small drawings on the home page's "What every business gets" tiles:
// shapes, not figures, each drawn in as its tile comes into view
// (welcome.css). Decoration only: the tile's own words say what it means.

const svgId = (id, name) => `wl-${name}-${id.replace(/[^\w-]/g, "")}`;

function BillArt() {
  return (
    <div className="wl-art wl-art-bill">
      <div className="wl-invoice">
        <div className="wl-invoice-head">
          <span className="wl-invoice-title">Tax invoice</span>
          <span className="wl-line" style={{ "--w": "38%" }} />
        </div>
        <span className="wl-line wl-grow" style={{ "--w": "82%", "--i": 0 }} />
        <span className="wl-line wl-grow" style={{ "--w": "64%", "--i": 1 }} />
        <span className="wl-line wl-grow" style={{ "--w": "73%", "--i": 2 }} />
        <div className="wl-invoice-tax">
          <span className="wl-rise" style={{ "--i": 3 }}><b>CGST</b><span className="wl-line" /></span>
          <span className="wl-rise" style={{ "--i": 4 }}><b>SGST</b><span className="wl-line" /></span>
        </div>
        <div className="wl-invoice-total wl-rise" style={{ "--i": 5 }}>
          <b>Total</b>
          <span className="wl-line" />
        </div>
        <span className="wl-invoice-stamp">Paid</span>
      </div>
      <div className="wl-methods">
        {["Cash", "UPI", "Card", "On credit"].map((name, index) => (
          <span key={name} className="wl-rise" style={{ "--i": index + 3 }}>{name}</span>
        ))}
      </div>
    </div>
  );
}

function MoneyArt() {
  const mask = svgId(useId(), "donut");
  return (
    <div className="wl-art wl-art-money">
      <svg className="wl-donut" viewBox="0 0 120 120" focusable="false">
        <mask id={mask}>
          <circle className="wl-donut-reveal" cx="60" cy="60" r="44" pathLength="100" />
        </mask>
        <g mask={`url(#${mask})`} transform="rotate(-90 60 60)">
          <circle className="wl-donut-part is-upi" cx="60" cy="60" r="44" pathLength="100" strokeDasharray="49 51" strokeDashoffset="0" />
          <circle className="wl-donut-part is-cash" cx="60" cy="60" r="44" pathLength="100" strokeDasharray="29 71" strokeDashoffset="-50" />
          <circle className="wl-donut-part is-card" cx="60" cy="60" r="44" pathLength="100" strokeDasharray="19 81" strokeDashoffset="-80" />
        </g>
      </svg>
      <ul className="wl-legend">
        <li className="wl-rise" style={{ "--i": 2 }}><i className="is-upi" />UPI</li>
        <li className="wl-rise" style={{ "--i": 3 }}><i className="is-cash" />Cash</li>
        <li className="wl-rise" style={{ "--i": 4 }}><i className="is-card" />Card</li>
      </ul>
    </div>
  );
}

const STOCK = [70, 52, 86, 16, 62, 40];

function StockArt() {
  return (
    <div className="wl-art wl-art-stock">
      <div className="wl-bars">
        {STOCK.map((level, index) => (
          <span key={index} className={level < 25 ? "is-low" : undefined} style={{ "--h": `${level}%`, "--i": index }} />
        ))}
      </div>
      <span className="wl-art-chip is-warn wl-rise" style={{ "--i": 6 }}>
        <Icon name="alert" size={13} /> Running low
      </span>
    </div>
  );
}

const PEOPLE = [
  { initial: "O", role: "Owner" },
  { initial: "M", role: "Manager" },
  { initial: "C", role: "Cashier" },
];

function StaffArt() {
  return (
    <div className="wl-art wl-art-staff">
      <ul className="wl-people">
        {PEOPLE.map((person, index) => (
          <li key={person.role} className="wl-rise" style={{ "--i": index }}>
            <span className="wl-face">{person.initial}</span>
            <span className="wl-role">{person.role}</span>
          </li>
        ))}
      </ul>
      <span className="wl-pin wl-rise" style={{ "--i": 3 }}>
        <Icon name="lock" size={14} />
        <i style={{ "--i": 0 }} /><i style={{ "--i": 1 }} /><i style={{ "--i": 2 }} /><i style={{ "--i": 3 }} />
      </span>
    </div>
  );
}

const TREND = "M4 70 C 22 64, 30 66, 46 54 S 76 42, 92 47 S 122 30, 142 31 S 176 14, 196 16";

function ReportsArt() {
  const fill = svgId(useId(), "area");
  return (
    <div className="wl-art wl-art-reports">
      <svg className="wl-chart" viewBox="0 0 200 84" focusable="false">
        <defs>
          <linearGradient id={fill} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.3" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="wl-chart-area" d={`${TREND} V 84 H 4 Z`} fill={`url(#${fill})`} />
        <path className="wl-chart-line" d={TREND} pathLength="1" />
        <circle className="wl-chart-dot" cx="196" cy="16" r="4.5" />
      </svg>
    </div>
  );
}

function BuyArt() {
  return (
    <div className="wl-art wl-art-buy">
      <span className="wl-truck"><Icon name="truck" size={22} /></span>
      <div className="wl-slip">
        <span className="wl-line wl-grow" style={{ "--w": "84%", "--i": 1 }} />
        <span className="wl-line wl-grow" style={{ "--w": "58%", "--i": 2 }} />
        <span className="wl-art-chip is-ok wl-rise" style={{ "--i": 3 }}>Free qty</span>
      </div>
    </div>
  );
}

const DUES = [
  { state: "Paid", tone: "is-ok" },
  { state: "Due in 3 days", tone: "is-warn" },
  { state: "Over 30 days", tone: "is-late" },
];

function DuesArt() {
  return (
    <div className="wl-art wl-art-dues">
      <ul className="wl-dues">
        {DUES.map((row, index) => (
          <li key={row.state} className="wl-rise" style={{ "--i": index }}>
            <span className="wl-face is-small" />
            <span className="wl-line" style={{ "--w": `${64 - index * 12}%` }} />
            <span className={`wl-art-chip ${row.tone}`}>{row.state}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CONSENTS = [
  { name: "Bills", on: true },
  { name: "Reminders", on: true },
  { name: "Offers", on: false },
];

function DataArt() {
  return (
    <div className="wl-art wl-art-data">
      <span className="wl-shield"><Icon name="shield" size={30} /></span>
      <ul className="wl-consents">
        {CONSENTS.map((item, index) => (
          <li key={item.name} className="wl-rise" style={{ "--i": index + 1 }}>
            <span>{item.name}</span>
            <span className={`wl-switch${item.on ? " is-on" : ""}`} style={{ "--i": index + 1 }}><i /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ART = { bill: BillArt, money: MoneyArt, stock: StockArt, staff: StaffArt, reports: ReportsArt, buy: BuyArt, dues: DuesArt, data: DataArt };

// The drawing for a tile, by the tile's key on the home page.
export default function TileArt({ kind }) {
  const Art = ART[kind];
  return Art ? <Art /> : null;
}
