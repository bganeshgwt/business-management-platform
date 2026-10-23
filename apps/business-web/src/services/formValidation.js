// The browser's "Please fill out this field." bubble — grey, English only,
// gone in a second — replaced, for every form in the app at once, by a
// message under the field, a red edge on it and focus on the first problem.
//
// Installed once in main.jsx. It listens for the browser's own `invalid`
// event (fired by required, type="email", min/max, pattern … on submit), so
// no form had to change. The message is worded from the field's label:
// "Enter product name", "Choose category", "Enter 1 or more". It clears as
// soon as the field is edited. A form (or any ancestor) marked
// data-native-validation keeps the browser's own behaviour.
//
// Forms built with <FormField error=…> show their own server-side messages
// the same way (.field-error).

const LABEL_SELECTOR = ".field-label, .field > span:first-child, .field > legend";

const labelOf = (control) => {
  const field = control.closest(".field, label");
  const labelled = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null;
  const node = labelled || field?.querySelector(LABEL_SELECTOR) || null;
  const text = (node ? node.textContent : "") || control.getAttribute("aria-label") || "";
  // "Price (₹) *" -> "Price"; "GSTIN (optional)" -> "GSTIN".
  return text.replace(/\([^)]*\)|\*/g, "").replace(/\s+/g, " ").trim();
};

// "Product name" -> "product name"; "GSTIN" stays "GSTIN".
const lower = (text) => (/^[A-Z0-9]{2}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1));

const messageFor = (control) => {
  const v = control.validity;
  const label = labelOf(control);
  const what = label ? lower(label) : "this";

  if (v.valueMissing) {
    if (control.type === "checkbox") return label ? `Tick “${label}” to go on` : "Tick this box to go on";
    if (control.tagName === "SELECT" || control.type === "radio") return `Choose ${what}`;
    if (control.type === "file") return `Attach ${what}`;
    return `Enter ${what}`;
  }
  if (v.typeMismatch) {
    if (control.type === "email") return "Enter an email address like name@business.in";
    if (control.type === "url") return "Enter a web address starting with https://";
    return `Check ${what}`;
  }
  if (v.rangeUnderflow) return `Enter ${control.min} or more`;
  if (v.rangeOverflow) return `Enter ${control.max} or less`;
  if (v.stepMismatch) return control.step === "1" ? "Enter a whole number" : `Use steps of ${control.step}`;
  if (v.tooShort) return `Use at least ${control.minLength} characters`;
  if (v.tooLong) return `Use at most ${control.maxLength} characters`;
  if (v.badInput) return control.type === "number" ? "Enter a number" : `Check ${what}`;
  if (v.patternMismatch) return control.title || `Check ${what}`;
  if (v.customError) return control.validationMessage;
  return control.validationMessage || `Check ${what}`;
};

// Where the message goes: inside the control's .field, else right after it.
const holderOf = (control) => control.closest(".field") || null;

const clear = (control) => {
  control.removeAttribute("aria-invalid");
  const id = control.dataset.autoErrorId;
  if (!id) return;
  document.getElementById(id)?.remove();
  holderOf(control)?.classList.remove("has-error");
  const rest = (control.getAttribute("aria-describedby") || "").split(" ").filter((part) => part && part !== id);
  if (rest.length) control.setAttribute("aria-describedby", rest.join(" "));
  else control.removeAttribute("aria-describedby");
  delete control.dataset.autoErrorId;
};

let counter = 0;
let firstOfSubmit = null;

const show = (control) => {
  clear(control);
  const id = `auto-error-${++counter}`;
  const note = document.createElement("small");
  note.className = "field-error field-error-auto";
  note.id = id;
  note.textContent = messageFor(control);
  const holder = holderOf(control);

  if (holder) {
    holder.appendChild(note);
    holder.classList.add("has-error");
  } else {
    control.insertAdjacentElement("afterend", note);
  }

  control.setAttribute("aria-invalid", "true");
  control.dataset.autoErrorId = id;
  control.setAttribute("aria-describedby", [control.getAttribute("aria-describedby"), id].filter(Boolean).join(" "));
};

let installed = false;

export function installFormValidation() {
  if (installed || typeof document === "undefined") return;
  installed = true;

  document.addEventListener(
    "invalid",
    (event) => {
      const control = event.target;
      if (!(control instanceof HTMLElement) || control.closest("[data-native-validation]")) return;
      event.preventDefault();
      show(control);

      // The first invalid field of this submit takes focus (the browser
      // would have, had its bubble not been turned off).
      if (!firstOfSubmit) {
        firstOfSubmit = control;
        setTimeout(() => {
          const target = firstOfSubmit;
          firstOfSubmit = null;
          if (target?.isConnected) {
            target.focus({ preventScroll: true });
            target.scrollIntoView?.({ block: "center" });
          }
        }, 0);
      }
    },
    true
  );

  const onEdit = (event) => {
    const control = event.target;
    if (control instanceof HTMLElement && control.dataset?.autoErrorId && control.validity?.valid) {
      clear(control);
    }
  };

  document.addEventListener("input", onEdit, true);
  document.addEventListener("change", onEdit, true);
}
