import { useEffect, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { dismissToast, subscribeToasts } from "../services/toast";

// The toasts from services/toast.js. Mounted once, in main.jsx. Bottom-right
// on a desktop, bottom-centre on a phone (@bmp/ui's styles/components.css .toaster).
const ICONS = { success: "check", error: "alert", warning: "alert", info: "info" };

function ToastItem({ item }) {
  const [paused, setPaused] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (paused || !item.duration) {
      return undefined;
    }

    timer.current = setTimeout(() => dismissToast(item.id), item.duration);
    return () => clearTimeout(timer.current);
  }, [item.id, item.duration, item.message, paused]);

  return (
    <div
      className={`toast toast-${item.tone}`}
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      data-testid="toast"
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon name={ICONS[item.tone] || "info"} size={16} />
      </span>
      <span className="toast-message">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action.onClick?.();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="toast-close" onClick={() => dismissToast(item.id)} aria-label="Dismiss">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export default function Toaster() {
  const [items, setItems] = useState([]);

  useEffect(() => subscribeToasts(setItems), []);

  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {items.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
    </div>
  );
}
