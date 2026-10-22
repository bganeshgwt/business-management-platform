import { Suspense, useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SidePanel from "../../../../../components/SidePanel";
import StatTile from "../../../../../components/StatTile";
import { PanelFooter } from "./panelKit";
import { resolvePanel } from "./panelRegistry";
import usePanelParam from "./usePanelParam";
import { PanelContext, usePanelClick } from "./panelContext";

// The dashboard's detail panels. Everything clickable on the dashboard stays a
// real link to its full screen (Ctrl/Cmd/middle-click open that in a new tab)
// but a plain click opens the detail here, over the dashboard, instead.
//
//   <DashboardPanels ctx={ctx}>…the dashboard…</DashboardPanels>
//   const onClick = usePanelClick("kitchen.late");   // inside it (panelContext.js)
//   <Link to="/kitchen" onClick={onClick}>…</Link>

// A link that opens panel `panel` on a plain click and stays a real link to
// `to` for everything else.
export function PanelLink({ panel, to, onClick, ...rest }) {
  const openPanel = usePanelClick(panel);

  return (
    <Link
      to={to}
      onClick={(event) => {
        onClick?.(event);
        openPanel(event);
      }}
      {...rest}
    />
  );
}

// A figure tile that opens its panel (and links to its screen).
export function PanelStatTile({ panel, ...props }) {
  const openPanel = usePanelClick(panel);

  return <StatTile {...props} onClick={props.to ? openPanel : undefined} />;
}

export default function DashboardPanels({ ctx, children }) {
  const { key, open, close } = usePanelParam();
  const panel = useMemo(() => (key ? resolvePanel(key, ctx) : null), [key, ctx]);
  const enabled = useCallback((wanted) => Boolean(resolvePanel(wanted, ctx)), [ctx]);
  const value = useMemo(() => ({ open, enabled }), [open, enabled]);
  // The last panel shown stays drawn while it slides away after closing.
  const [last, setLast] = useState(panel);

  if (panel && (!last || last.key !== panel.key)) {
    setLast(panel);
  }

  const shown = panel || last;
  const Content = shown ? shown.Content : null;

  return (
    <PanelContext.Provider value={value}>
      {children}
      <SidePanel
        open={Boolean(panel)}
        title={shown ? shown.title : ""}
        count={shown ? shown.count : null}
        rule={shown ? shown.rule : ""}
        icon={shown ? shown.icon : undefined}
        onClose={close}
        toolbar={
          shown && shown.views ? (
            <div className="segmented" role="radiogroup" aria-label="Show">
              {shown.views.map((view) => (
                <button
                  type="button"
                  key={view.key}
                  role="radio"
                  aria-checked={shown.view === view.key}
                  className={`segment ${shown.view === view.key ? "is-active" : ""}`}
                  onClick={() => open(`${shown.name}.${view.key}`)}
                >
                  {view.label}
                </button>
              ))}
            </div>
          ) : null
        }
        footer={shown ? <PanelFooter to={shown.href} note="Figures update with the dashboard." /> : null}
      >
        {shown && (
          <Suspense
            fallback={
              <div className="dash-skeleton" aria-label="Loading">
                <span />
                <span />
                <span />
              </div>
            }
          >
            <Content key={shown.key} ctx={ctx} view={shown.view} />
          </Suspense>
        )}
      </SidePanel>
    </PanelContext.Provider>
  );
}
