// Small single-series charts drawn as inline SVG/CSS, so the app needs no chart
// library. One series means no legend is needed: the card title names it.
import { useId, useLayoutEffect, useRef, useState } from "react";
import { money } from "../services/format";
import { motionAllowed, play } from "./motion";

const CHART_HUE = "var(--chart-hue)";
// How long the trend line takes to draw (--motion-draw in motion.css); the
// points pop in along it.
const DRAW_MS = 640;
// Past this many points the dots simply arrive with the line.
const POINTS_THAT_POP = 45;
// The longest entrance (eight staggered bars, or the line with its last dot
// popping on), with a margin; after this the chart is settled.
const ENTRANCE_MS = 1100;

// Draw a graph in when it first reaches the screen, including charts below
// a long dashboard: lines draw, bars and columns grow from their baseline
// (motion.css, under .chart-revealed). A chart already on screen is marked
// before the first paint, so it never flashes complete and then restarts.
// Unobserved — or with reduced motion — the chart is simply complete.
//
// Once the entrance has played the chart is "settled" (.chart-settled) and
// the entrance never plays again: the browser restarts a CSS animation on an
// element that is moved, so without this a bar whose dish changed places on
// a refresh would regrow from zero. On a settled chart a moved row glides
// (useRowGlide), a changed bar glides (useBarGlide) and a new bar grows in
// on its own.
function useChartEntrance(hasData) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !hasData || !motionAllowed() || node.classList.contains("chart-revealed")) return undefined;
    const reveal = () => {
      node.classList.add("chart-revealed");
      // Not cleared on clean-up: the class is harmless on a chart that has
      // gone, and a chart that stays must always settle.
      window.setTimeout(() => node.classList.add("chart-settled"), ENTRANCE_MS);
    };
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.bottom > 0 && box.top < window.innerHeight) {
      reveal();
      return undefined;
    }
    if (!window.IntersectionObserver) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        reveal();
        observer.disconnect();
      }
    }, { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasData]);
  return ref;
}

// When a bar's figure changes on a chart that is already showing (a live
// refresh), the bar glides from its old length to the new one; a bar that a
// refresh adds to a settled chart grows in from its baseline. Only transform
// moves; the bar's real size is set at once.
// `sizes` is [{ key, size }] with size in percent, in drawing order.
function useBarGlide(ref, sizes, selector, axis) {
  const previous = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const before = previous.current;
    previous.current = new Map(sizes.map((item) => [item.key, item.size]));
    if (!node || !before || !node.classList.contains("chart-revealed") || !motionAllowed()) return;
    const settled = node.classList.contains("chart-settled");
    const fills = node.querySelectorAll(selector);
    const scale = (ratio) => (axis === "x" ? `scaleX(${ratio})` : `scaleY(${ratio})`);
    sizes.forEach((item, index) => {
      const old = before.get(item.key);
      const fill = fills[index];
      if (!fill || !item.size) return;
      if (old === undefined) {
        // Still in its entrance, the chart grows new bars in with the rest.
        if (settled) play(fill, [{ transform: scale(0) }, { transform: "none" }], { duration: 480 });
        return;
      }
      if (Math.abs(old - item.size) < 0.5) return;
      play(fill, [{ transform: scale(old / item.size) }, { transform: "none" }], { duration: 480 });
    });
  });
}

// When a refresh puts the rows of a list in a new order (two dishes swap
// places in the top five), each row glides from where it was to where it now
// is, instead of the list being redrawn. Positions are within the list, so
// the list itself moving on the page does not count. Only transform moves.
// `keys` are the rows' keys, in drawing order.
function useRowGlide(ref, keys) {
  const previous = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      previous.current = null;
      return;
    }
    const rows = [...node.children];
    const base = (row) => (row.offsetParent === node ? 0 : node.offsetTop);
    const now = new Map(keys.map((key, index) => [key, rows[index] ? rows[index].offsetTop - base(rows[index]) : 0]));
    const before = previous.current;
    previous.current = now;
    if (!before || !node.classList.contains("chart-revealed") || !motionAllowed()) return;
    keys.forEach((key, index) => {
      const old = before.get(key);
      const row = rows[index];
      if (!row || old === undefined) return;
      const shift = old - now.get(key);
      if (Math.abs(shift) >= 1) play(row, [{ transform: `translateY(${shift}px)` }, { transform: "none" }], { duration: 420 });
    });
  });
}

// Keys for rows that are told apart by their label: two rows can share a
// label (two staff called "Ravi"), so the second becomes "Ravi#2". Keyed by
// label rather than position, a row that moves up the list is the same row.
const labelKeys = (rows) => {
  const seen = new Map();
  return rows.map((row) => {
    const label = String(row.label);
    const times = (seen.get(label) || 0) + 1;
    seen.set(label, times);
    return times > 1 ? `${label}#${times}` : label;
  });
};

// Sales over the last few days: an area under a thin line, with a dot per point
// and the value on hover.
//
// Days with nothing sold come in as zeroes and are drawn as zeroes — a closed
// Monday dips to the floor rather than being skipped. A long range (a month, a
// year) keeps every point but labels only some of them, so the dates never
// run into each other.
//
// `label` names the chart for a screen reader ("Sales, last 7 days").
// `format` turns a value into text; money by default.
export function TrendChart({ points, currency = "₹", height = 140, label, format }) {
  const chartRef = useChartEntrance(points.length > 0);
  const hintId = useId();
  const [activeIndex, setActiveIndex] = useState(null);
  const show = format || ((value) => money(value, currency));

  if (points.length === 0) {
    return <p className="muted small">No sales in this period yet.</p>;
  }

  const width = 560;
  // Room on the right for the peak value, so the line has a scale to read
  // against — without it the same shape could be ten thousand or ten lakh.
  const padding = { top: 16, right: 64, bottom: 22, left: 12 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const max = Math.max(...points.map((point) => point.value), 1);
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  // About eight dates fit under the line. The last point is always labelled,
  // and the regular label just before it is dropped if the two would touch.
  const labelEvery = points.length > 10 ? Math.ceil(points.length / 8) : 1;
  const lastIndex = points.length - 1;
  const labelled = (index) =>
    index === lastIndex ||
    (index % labelEvery === 0 && (labelEvery === 1 || lastIndex - index >= labelEvery));
  const dotRadius = points.length > 45 ? 2 : points.length > 20 ? 3 : 4;

  const coords = points.map((point, index) => ({
    ...point,
    x: padding.left + index * stepX,
    y: padding.top + plotHeight - (point.value / max) * plotHeight,
  }));

  // The last point is often today, which is only part traded. Drawn solid it
  // reads as a collapse at four in the afternoon; drawn dashed and hollow it
  // reads as what it is — a day still going.
  const settled = coords.filter((point) => !point.inProgress);
  const live = coords.slice(settled.length - 1);

  const line = settled.map((point) => `${point.x},${point.y}`).join(" ");
  const liveLine = live.length > 1 ? live.map((point) => `${point.x},${point.y}`).join(" ") : "";
  const lastSettled = settled[settled.length - 1] || coords[0];
  const area = `${padding.left},${padding.top + plotHeight} ${line} ${lastSettled.x},${
    padding.top + plotHeight
  }`;

  const selectedIndex = activeIndex === null ? lastIndex : Math.min(activeIndex, lastIndex);
  const selected = coords[selectedIndex];
  const inspectPoint = (event) => {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const cursor = svg.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    const x = cursor.matrixTransform(matrix.inverse()).x;
    setActiveIndex(stepX ? Math.max(0, Math.min(lastIndex, Math.round((x - padding.left) / stepX))) : 0);
  };
  const inspectWithKeys = (event) => {
    const next = {
      ArrowLeft: Math.max(0, selectedIndex - 1),
      ArrowRight: Math.min(lastIndex, selectedIndex + 1),
      Home: 0,
      End: lastIndex,
      Escape: null,
    };
    if (Object.hasOwn(next, event.key)) {
      event.preventDefault();
      setActiveIndex(next[event.key]);
    }
  };

  return (
    <div className="trend-chart" ref={chartRef}>
      <div className="trend-readout" role="status" aria-live="polite" aria-atomic="true">
        <span className="trend-readout-label">{activeIndex === null ? "Latest: " : ""}{selected.label}{selected.inProgress ? " · still trading" : ""}</span>
        {/* Keyed by the point, so each newly inspected value fades in. */}
        <strong className="trend-readout-value" key={selectedIndex}>{show(selected.value)}</strong>
      </div>
      <span className="sr-only" id={hintId}>Point or tap to inspect a day. With the chart focused, use Left and Right arrow keys, or Home and End.</span>
    <svg
      className={`chart ${points.length > POINTS_THAT_POP ? "has-many-points" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label || `Sales trend over ${points.length} days`}
      aria-describedby={hintId}
      tabIndex={0}
      onPointerMove={inspectPoint}
      onPointerDown={inspectPoint}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setActiveIndex(null); }}
      onKeyDown={inspectWithKeys}
      onFocus={() => setActiveIndex(index => index ?? lastIndex)}
      onBlur={() => setActiveIndex(null)}
    >
      {/* A single recessive baseline instead of a full grid. */}
      <line
        x1={padding.left}
        y1={padding.top + plotHeight}
        x2={width - padding.right}
        y2={padding.top + plotHeight}
        className="chart-axis"
      />

      {/* The peak, labelled where it happens, and the floor at zero. */}
      <text x={width - padding.right + 8} y={padding.top + 4} className="chart-scale">
        {show(max)}
      </text>
      {/* Sat on the baseline with a hanging baseline, this dropped straight
          onto the last date label. It now rests just above the axis line. */}
      <text
        x={width - padding.right + 8}
        y={padding.top + plotHeight - 3}
        className="chart-scale"
      >
        {show(0)}
      </text>

      <polygon className="trend-area" points={area} fill={CHART_HUE} opacity="0.12" />
      <polyline className="trend-line" pathLength="1000" points={line} fill="none" stroke={CHART_HUE} strokeWidth="2" strokeLinejoin="round" />

      {activeIndex !== null && (
        <line className="trend-guide" x1={selected.x} x2={selected.x} y1={padding.top} y2={padding.top + plotHeight} />
      )}

      {liveLine && (
        <polyline
          className="trend-live"
          points={liveLine}
          fill="none"
          stroke={CHART_HUE}
          strokeWidth="2"
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />
      )}

      {coords.map((point, index) => (
        <g key={`${index}-${point.label}`}>
          <circle
            className="trend-point"
            style={{ "--point-delay": `${Math.round((DRAW_MS * index) / Math.max(lastIndex, 1))}ms` }}
            cx={point.x}
            cy={point.y}
            r={activeIndex !== null && index === selectedIndex ? dotRadius + 2 : dotRadius}
            fill={point.inProgress ? "var(--surface)" : CHART_HUE}
            stroke={point.inProgress ? CHART_HUE : "var(--surface)"}
            strokeWidth="2"
          >
            <title>
              {`${point.label}: ${show(point.value)}${point.inProgress ? " — still trading" : ""}`}
            </title>
          </circle>
          {labelled(index) && (
            <text x={point.x} y={height - 6} textAnchor="middle" className="chart-label">
              {point.label}
            </text>
          )}
        </g>
      ))}
    </svg>
    </div>
  );
}

// Top items by revenue: horizontal bars, because the labels are words and
// length is the easiest magnitude to compare.
// `scale` sets what a full bar means, for the case where the rows are a slice
// of something bigger. A list of the five slowest dishes scaled to itself
// draws the slowest one as a full bar, which says the opposite of the truth;
// scaled to the day's best seller, it looks as small as it is.
//
// `format` turns a value into text (money by default), for lists counted in
// something else — plates, bills. `empty` is what to say when there are no rows.
export function BarList({ rows, currency = "₹", scale, format, empty = "Nothing sold yet." }) {
  const chartRef = useChartEntrance(rows.length > 0);
  const max = Math.max(scale || 0, ...rows.map((row) => row.value), 1);
  const keys = labelKeys(rows);
  const sizes = rows.map((row, index) => ({ key: keys[index], size: Math.max((row.value / max) * 100, 2) }));
  useBarGlide(chartRef, sizes, ".bar-fill", "x");
  useRowGlide(chartRef, keys);

  if (rows.length === 0) {
    return <p className="muted small">{empty}</p>;
  }

  const show = format || ((value) => money(value, currency));

  return (
    <ul className="bar-list" ref={chartRef}>
      {/* Keyed by label (labelKeys), so a row that changes place on a
          refresh glides there. --i staggers the bars as they grow in. */}
      {rows.map((row, index) => (
        <li key={sizes[index].key} style={{ "--i": index }}>
          <span className="bar-label" title={row.label}>
            {row.label}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${sizes[index].size}%` }} />
          </span>
          <span className="bar-value">
            {show(row.value)}
            {row.sub !== undefined && <small className="muted"> · {row.sub}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The shape of a single day: one column per hour, so the rush is obvious at a
// glance. Vertical bars because time reads left to right.
//
// Quiet hours are drawn as empty columns rather than left out. Omitting them
// puts noon next to two o'clock as if they were consecutive, which turns the
// axis into a lie about when the restaurant was busy.
export function ColumnChart({ points, currency = "₹", height = 130 }) {
  const chartRef = useChartEntrance(points.length > 0);
  const max = Math.max(...points.map((point) => point.value), 1);
  const sizes = points.map((point) => ({ key: point.label, size: point.value > 0 ? Math.max((point.value / max) * 100, 3) : 0 }));
  useBarGlide(chartRef, sizes, ".column-fill", "y");

  if (points.length === 0) {
    return <p className="muted small">Nothing billed yet today.</p>;
  }

  const labelEvery = points.length > 8 ? Math.ceil(points.length / 8) : 1;

  return (
    // The columns rise as one quick sweep, left to right, about a third of
    // a second end to end however many there are.
    <div className="column-chart" style={{ height, "--column-step": `${Math.min(18, Math.round(300 / points.length))}ms` }} ref={chartRef}>
      {points.map((point, index) => (
        <div className="column" key={point.label} style={{ "--i": index }}>
          <span className="column-track">
            <span
              className={`column-fill ${point.value > 0 ? "" : "is-empty"}`}
              style={{ height: point.value > 0 ? `${sizes[index].size}%` : "2px" }}
              title={`${point.label}: ${money(point.value, currency)}`}
            />
          </span>
          <span className="column-label">
            {index % labelEvery === 0 ? point.label : "\u00a0"}
          </span>
        </div>
      ))}
    </div>
  );
}
