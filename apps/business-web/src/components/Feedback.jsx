// Small shared blocks so every screen shows loading, errors and success the same way.
//
// The alerts carry their icon in CSS (.alert::before), not in this markup, so
// the dozens of hand-written <div className="alert"> across the pages get the
// same mark without each one being edited.
import Icon from "@bmp/ui/Icon";

export function Loading({ label = "Loading…" }) {
  return (
    <p className="muted loading-line" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ScreenLoading({ label = "Loading screen…" }) {
  return (
    <div className="screen-loading" role="status" aria-label={label}>
      <p className="muted loading-line"><span className="spinner" aria-hidden="true" />{label}</p>
      <div aria-hidden="true">
        <span className="screen-skeleton-block screen-skeleton-title" />
        <span className="screen-skeleton-block screen-skeleton-subtitle" />
        <div className="screen-skeleton-tiles">
          {Array.from({ length: 4 }, (_, index) => <span key={index} className="screen-skeleton-block" />)}
        </div>
        <div className="screen-skeleton-body">
          {Array.from({ length: 5 }, (_, index) => <span key={index} className="screen-skeleton-block" />)}
        </div>
      </div>
    </div>
  );
}

export function ErrorMessage({ message }) {
  if (!message) {
    return null;
  }

  return (
    <div className="alert" role="alert">
      {message}
    </div>
  );
}

export function SuccessMessage({ message }) {
  if (!message) {
    return null;
  }

  return (
    <div className="alert alert-success" role="status">
      {message}
    </div>
  );
}

// Nothing here — and, where there is one, the way out.
//
// A bare sentence in the middle of a card tells someone the list is empty,
// which they can already see. What they cannot see is whether that is normal,
// or whether they have work to do. `hint` says which, and `action` gives them
// somewhere to go rather than making them find the right menu item.
//
// `icon` (optional) is an Icon name that says what is missing — "receipt" for
// no bills, "users" for no guests. Without one, the drawn tray stands in.
export function EmptyState({ message, hint, action, icon }) {
  return (
    <div className="empty-state">
      <span className="empty-state-art" aria-hidden="true">
        {icon ? (
          <Icon name={icon} size={26} strokeWidth={1.75} />
        ) : (
          <svg className="empty-state-mark" viewBox="0 0 48 40" focusable="false">
            <rect x="1" y="7" width="46" height="32" rx="4" />
            <path d="M1 17h46" />
            <path d="M13 7V3h22v4" />
            <circle cx="24" cy="28" r="5" />
          </svg>
        )}
      </span>

      <p className="empty-state-message">{message}</p>
      {hint && <p className="empty-state-hint">{hint}</p>}
      {action}
    </div>
  );
}
