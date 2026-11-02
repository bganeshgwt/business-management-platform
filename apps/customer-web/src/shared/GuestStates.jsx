import Icon from "@bmp/ui/Icon";
import { telHref } from "./guestWords";
import "./shared.css";

// The states every guest page has besides its content, in one look: nothing
// to show yet, something went wrong, and loading.

// Nothing to show yet: what, and what the guest can do. `heading` is "h1" when
// it is all the page shows.
//   <GuestEmpty icon="calendar" title="No bookings on this phone yet">Book from the link the salon shared.</GuestEmpty>
export function GuestEmpty({ icon = "info", title, children, action = null, heading: Heading = "h2" }) {
  return (
    <section className="gs-state">
      <span className="gs-state-mark" aria-hidden="true">
        <Icon name={icon} size={26} />
      </span>
      <Heading>{title}</Heading>
      {children && <p>{children}</p>}
      {action}
    </section>
  );
}

// Something went wrong: what, in the guest's words, and what to do about it:
// try again (when it can help), or call the business (when its phone is known).
//   <GuestError message={guestErrorMessage(error)} onRetry={load} phone={card?.location.phone} />
export function GuestError({ title = "Something went wrong", message, onRetry = null, retrying = false, phone = null, icon = "alert-circle", heading: Heading = "h2" }) {
  const call = telHref(phone);

  return (
    <section className="gs-state is-error" role="alert">
      <span className="gs-state-mark" aria-hidden="true">
        <Icon name={icon} size={26} />
      </span>
      <Heading>{title}</Heading>
      {message && <p>{message}</p>}
      {(onRetry || call) && (
        <div className="gs-state-actions">
          {onRetry && (
            <button type="button" className="g-primary" onClick={onRetry} disabled={retrying}>
              <Icon name="refresh" size={16} /> {retrying ? "Trying…" : "Try again"}
            </button>
          )}
          {call && (
            <a className="g-secondary gs-call" href={call}>
              <Icon name="phone" size={16} /> Call {phone}
            </a>
          )}
        </div>
      )}
    </section>
  );
}

// Placeholders while a page loads, in its own shape: the business band, then
// cards of lines. The shimmer is the platform's (.skeleton, still for reduced
// motion).
//   <GuestSkeleton band cards={2} />
export function GuestSkeleton({ band = false, cards = 2, lines = 3, label = "Loading" }) {
  return (
    <div className="gs-skeleton" aria-busy="true" aria-label={label}>
      {band && (
        <div className="gs-skeleton-band">
          <span className="skeleton gs-sk-mark" />
          <span className="gs-sk-lines">
            <span className="skeleton gs-sk-line is-wide" />
            <span className="skeleton gs-sk-line" />
          </span>
        </div>
      )}
      {Array.from({ length: cards }, (_, card) => (
        <div key={card} className="gs-skeleton-card">
          {Array.from({ length: lines }, (_, line) => (
            <span key={line} className={`skeleton gs-sk-line ${line === 0 ? "is-wide" : ""}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
