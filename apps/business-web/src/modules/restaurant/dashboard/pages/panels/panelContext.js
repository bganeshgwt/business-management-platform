import { createContext, useCallback, useContext } from "react";
import { plainClick } from "./usePanelParam";

// How anything inside the dashboard opens a panel (DashboardPanels.jsx
// provides it).
export const PanelContext = createContext({ open: () => {}, enabled: () => false });

// The click handler for something that opens panel `key`. Nothing happens
// (the link is followed as before) when the person may not open that panel.
export function usePanelClick(key) {
  const { open, enabled } = useContext(PanelContext);

  return useCallback(
    (event) => {
      if (!key || !enabled(key) || !plainClick(event)) {
        return;
      }

      event.preventDefault();
      open(key);
    },
    [enabled, key, open]
  );
}

