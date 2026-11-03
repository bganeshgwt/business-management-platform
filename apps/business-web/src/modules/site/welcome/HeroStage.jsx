import { useEffect, useId, useMemo, useRef, useState } from "react";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import { BUSINESS_ACCENTS } from "@bmp/ui/businessIcons";
import SceneArt from "./SceneArt";
import { SCENES } from "./scenes";
import { useTilt } from "./pageMotion";

// The home page's moving tour: a window onto the platform's screens, one kind
// of business after another (scenes.js, drawn by SceneArt.jsx), with notes
// floating beside it.
// The tabs below choose a scene; on their own they move on as the active
// tab's line fills (welcome.css), which pauses while the pointer is on the
// tour, while a key has focus in it, while it is off screen, and for good
// with the pause button. With reduced motion nothing moves on by itself.
// Only the types the price list offers are shown.

// A pattern that looks like a QR code and is not one: the restaurant's note
// shows that a bill carries one, and nothing here can be scanned to pay.
const QR_PATH = (() => {
  const finders = [[0, 0], [14, 0], [0, 14]];
  let seed = 11;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const finder = (x, y) => {
    for (const [left, top] of finders) {
      const dx = x - left;
      const dy = y - top;
      if (dx < -1 || dx > 7 || dy < -1 || dy > 7) continue;
      if (dx < 0 || dx > 6 || dy < 0 || dy > 6) return false;
      return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    }
    return null;
  };
  let path = "";
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 21; x += 1) {
      if (finder(x, y) ?? random() > 0.5) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return path;
})();

const CLOCK = new Intl.DateTimeFormat("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit" });

function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  return <span className="wl-window-clock">{CLOCK.format(now)}</span>;
}

const PauseMark = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M8 5v14M16 5v14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

const PlayMark = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" />
  </svg>
);

export default function HeroStage({ types }) {
  const id = useId();
  const stageRef = useRef(null);
  const tabs = useRef([]);
  const [chosen, setChosen] = useState(0);
  const [paused, setPaused] = useState(false);
  const scenes = useMemo(() => (types.length ? SCENES.filter((scene) => types.some((type) => type.code === scene.type)) : SCENES), [types]);
  // A scene's mark: its type's, as the platform sets it (the price list's
  // types), in its accent, as the business's own top bar shows it.
  const markOf = (scene) => {
    const type = types.find((entry) => entry.code === scene.type);
    return { icon: type?.icon || scene.icon, color: BUSINESS_ACCENTS[type?.accent] || null };
  };
  useTilt(stageRef);

  if (!scenes.length) return null;

  const current = chosen < scenes.length ? chosen : 0;
  const scene = scenes[current];
  const tour = scenes.length > 1;

  const show = (index, focus = false) => {
    const next = (index + scenes.length) % scenes.length;
    setChosen(next);
    if (focus) tabs.current[next]?.focus();
  };

  // Arrow keys, Home and End move between the tabs, as tabs do.
  const onKeyDown = (event) => {
    const moves = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: scenes.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    show(moves[event.key], true);
  };

  return (
    <div ref={stageRef} className={`wl-stage${paused ? " is-paused" : ""}`}>
      <div className="wl-frame">
        <div className="wl-stage-halo" aria-hidden="true" />
        <div className="wl-window">
          <div className="wl-window-bar" aria-hidden="true">
            <span className="wl-window-dots"><i /><i /><i /></span>
            <span key={scene.type} className="wl-window-place">
              <BrandMark size={20} {...markOf(scene)} />
              {scene.place}
            </span>
            <LiveClock />
          </div>
          <div className="wl-scenes">
            {scenes.map((item, index) => {
              const active = index === current;
              return (
                <div
                  key={item.type}
                  id={`${id}-scene-${index}`}
                  className={`wl-scene${active ? " is-active" : ""}`}
                  role={tour ? "tabpanel" : undefined}
                  aria-labelledby={tour ? `${id}-tab-${index}` : undefined}
                  aria-hidden={active ? undefined : "true"}
                  inert={!active}
                >
                  <p className="sr-only">{item.summary}</p>
                  <div aria-hidden="true">
                    <SceneArt type={item.type} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {scenes.map((item, index) =>
          item.notes.map((note, place) => (
            <div key={`${item.type}-${note.title}`} className={`wl-note wl-note-${place}${index === current ? " is-active" : ""}`} aria-hidden="true">
              <div className="wl-note-card">
                {note.qr ? (
                  <span className="wl-note-icon is-qr">
                    <svg className="wl-qr" viewBox="0 0 21 21" shapeRendering="crispEdges" focusable="false">
                      <path d={QR_PATH} />
                    </svg>
                  </span>
                ) : (
                  <span className="wl-note-icon"><Icon name={note.icon} size={18} /></span>
                )}
                <span>
                  <strong>{note.title}</strong>
                  <small>{note.text}</small>
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {tour && (
        <div className="wl-tour">
          <div className="wl-tour-tabs" role="tablist" aria-label="The platform's screens for each kind of business" onKeyDown={onKeyDown}>
            {scenes.map((item, index) => {
              const active = index === current;
              return (
                <button
                  key={item.type}
                  ref={(node) => {
                    tabs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${index}`}
                  aria-selected={active}
                  aria-controls={`${id}-scene-${index}`}
                  tabIndex={active ? 0 : -1}
                  className={`wl-tour-tab${active ? " is-active" : ""}`}
                  onClick={() => show(index)}
                >
                  <Icon name={markOf(item).icon} size={15} />
                  {item.label}
                  {active && <span className="wl-tour-line" aria-hidden="true" onAnimationEnd={() => show(current + 1)} />}
                </button>
              );
            })}
          </div>
          <button type="button" className="wl-tour-pause" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Play the tour" : "Pause the tour"}>
            {paused ? <PlayMark /> : <PauseMark />}
          </button>
        </div>
      )}
    </div>
  );
}
