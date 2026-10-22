// "Are you sure?" as a promise, drawn as the app's own ConfirmDialog instead
// of the browser's grey window.confirm box. <ConfirmHost/> (mounted once in
// main.jsx) draws it.
//
//   import { confirmAction } from "../services/confirm";   // or useConfirm()
//   if (!(await confirmAction({ title: "Switch off Udhaar?", message: "…", confirmLabel: "Switch off" }))) return;
//
// Options: title, message (text or element), confirmLabel (default
// "Confirm"), cancelLabel ("Cancel"), tone "danger" (default: red button and
// warning mark) or "primary" (an ordinary yes/no). Resolves true for the
// confirm button, false for Cancel, Escape or the backdrop. Without a host
// on the page it falls back to window.confirm, so it never hangs.

let current = null;
const listeners = new Set();

const emit = () => listeners.forEach((listener) => listener(current));

export const subscribeConfirm = (listener) => {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
};

export const hasConfirmHost = () => listeners.size > 0;

export const settleConfirm = (answer) => {
  const open = current;
  current = null;
  emit();
  open?.resolve(Boolean(answer));
};

export const confirmAction = (options = {}) => {
  const settings = typeof options === "string" ? { message: options } : options;

  if (!hasConfirmHost()) {
    const text = [settings.title, typeof settings.message === "string" ? settings.message : ""].filter(Boolean).join("\n\n");
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(text) : false);
  }

  // A second question while one is open: the first is answered "no".
  if (current) {
    settleConfirm(false);
  }

  return new Promise((resolve) => {
    current = {
      title: settings.title || "Are you sure?",
      message: settings.message || "",
      confirmLabel: settings.confirmLabel || "Confirm",
      cancelLabel: settings.cancelLabel || "Cancel",
      tone: settings.tone || "danger",
      resolve,
    };
    emit();
  });
};

export default confirmAction;
