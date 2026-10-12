import { Children, cloneElement, isValidElement, useId } from "react";

// One labelled field: the label, the control, a hint and — when something is
// wrong — the message right under it, linked to the control so a screen
// reader reads it too.
//
//   <FormField label="Product name" error={errors.name}>
//     <input value={name} onChange={…} />
//   </FormField>
//   <FormField label="GSTIN" optional hint="15 characters, on the supplier's bill">
//     <input … />
//   </FormField>
//
// The rule for the whole app: mark the optional fields "(optional)" and
// leave the required ones plain — never a "*". `required` adds the native
// required, which the app's inline checker (services/formValidation.js)
// turns into a message under the field instead of the browser's bubble.
//
// label     text (or element) above the control
// hint      a quiet line under it
// error     the message; also sets aria-invalid on the control
// optional  adds "(optional)" after the label
// required  marks the control required
// wide      spans both columns of a .form-grid
// The single child element gets id, aria-invalid and aria-describedby.
export default function FormField({ label, hint, error, optional = false, required = false, wide = false, className = "", children, id }) {
  const ownId = useId();
  const child = Children.count(children) === 1 && isValidElement(children) ? children : null;
  const controlId = id || child?.props.id || `${ownId}-control`;
  const hintId = `${ownId}-hint`;
  const errorId = `${ownId}-error`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null, child?.props["aria-describedby"]].filter(Boolean).join(" ") || undefined;

  const control = child
    ? cloneElement(child, {
        id: controlId,
        "aria-invalid": error ? true : child.props["aria-invalid"],
        "aria-describedby": describedBy,
        required: required || child.props.required,
      })
    : children;

  return (
    <div className={`field ${wide ? "field-wide" : ""} ${error ? "has-error" : ""} ${className}`.trim()}>
      {label && (
        <label htmlFor={controlId} className="field-label">
          {label}
          {optional && <span className="field-optional"> (optional)</span>}
        </label>
      )}
      {control}
      {error && (
        <small id={errorId} className="field-error" role="alert">
          {error}
        </small>
      )}
      {hint && (
        <small id={hintId} className="muted field-hint">
          {hint}
        </small>
      )}
    </div>
  );
}
