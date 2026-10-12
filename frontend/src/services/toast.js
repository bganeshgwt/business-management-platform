// A short message in the corner after something worked (or did not) — the
// one way every screen says "Item saved", so it is seen even when the form
// that saved it has closed. <Toaster/> (mounted once in main.jsx) draws them.
//
//   import { toast } from "../services/toast";      // anywhere, even outside React
//   toast.success("Item saved");
//   toast.error("Could not save: the name is taken");
//   toast.info("Printing…", { duration: 2000 });
//   toast.success("Bill settled", { action: { label: "Print", onClick: print } });
//
// Inside a component, useToast() (hooks/useToast.js) returns the same object.
// A toast stays 4 s (errors 7 s), pauses while hovered or focused, and is
// read out politely by screen readers (errors assertively).

let items = [];
let nextId = 1;
const listeners = new Set();

const emit = () => listeners.forEach((listener) => listener(items));

export const subscribeToasts = (listener) => {
  listeners.add(listener);
  listener(items);
  return () => listeners.delete(listener);
};

export const dismissToast = (id) => {
  items = items.filter((item) => item.id !== id);
  emit();
};

const show = (tone, message, { duration, action, id } = {}) => {
  if (!message) {
    return null;
  }

  const key = id || nextId++;
  const toastItem = {
    id: key,
    tone,
    message: String(message),
    action: action || null,
    duration: duration ?? (tone === "error" ? 7000 : 4000),
  };

  // The same id replaces the toast in place ("Saving…" -> "Saved"); at most
  // four on screen, oldest first out.
  items = [...items.filter((item) => item.id !== key), toastItem].slice(-4);
  emit();
  return key;
};

export const toast = {
  show: (message, options) => show("info", message, options),
  success: (message, options) => show("success", message, options),
  error: (message, options) => show("error", message, options),
  info: (message, options) => show("info", message, options),
  warning: (message, options) => show("warning", message, options),
  dismiss: dismissToast,
};

export default toast;
