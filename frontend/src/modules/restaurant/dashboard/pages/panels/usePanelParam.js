import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

// Which dashboard panel is open, kept in the address (?panel=kitchen-late), so
// the browser's Back closes it and a reload opens it again.
//
// Opening adds a history entry; closing a panel this tab opened goes back
// through that entry (so Back and the × agree and history does not grow). A
// panel that came with the address (a reload, a shared link) is closed by
// replacing the address instead — going back would leave the dashboard.
// Switching between views of one panel replaces, so Back still closes it.
export default function usePanelParam() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const key = params.get("panel") || null;
  const opened = Boolean(location.state && location.state.dashPanel);

  const addressWith = useCallback(
    (next) => {
      const search = new URLSearchParams(location.search);

      if (next) {
        search.set("panel", next);
      } else {
        search.delete("panel");
      }

      const text = search.toString();
      return `${location.pathname}${text ? `?${text}` : ""}`;
    },
    [location.pathname, location.search]
  );

  const open = useCallback(
    (next) => {
      if (next === key) {
        return;
      }

      // Already in a panel: swap views without a new history step.
      navigate(addressWith(next), { replace: Boolean(key), state: { dashPanel: key ? opened : true } });
    },
    [addressWith, key, navigate, opened]
  );

  const close = useCallback(() => {
    if (!key) {
      return;
    }

    if (opened && window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate(addressWith(null), { replace: true });
  }, [addressWith, key, navigate, opened]);

  return { key, open, close };
}

// A click that should open the panel rather than follow the link. Ctrl/Cmd,
// Shift, Alt and middle-clicks keep the browser's own meaning (a new tab or
// window on the full page), because the element is still a real link.
export const plainClick = (event) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
