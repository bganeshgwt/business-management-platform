import { useEffect, useState } from "react";

// A settings screen, the same in the restaurant and in Business Admin: an
// "On this page" index on the left (a strip of links on a phone), the
// sections in the middle filling the card width, and a save bar that stays
// at the bottom of the window saying whether there is anything to save.
//
//   <form onSubmit={save} noValidate={false}>
//     <SettingsLayout sections={[{ id: "details", label: "Business details" }, …]}>
//       <SectionCard id="details" …>…</SectionCard>
//       …
//     </SettingsLayout>
//     <SettingsSaveBar dirty={dirty} saving={busy} savedAt={savedAt} onReset={reset} />
//   </form>
//
// sections   [{ id, label }] — each id is the id of a section on the page
// title      the index's heading (default "On this page")
export default function SettingsLayout({ sections = [], title = "On this page", children, className = "" }) {
  const [current, setCurrent] = useState(sections[0]?.id);

  // The section in view is marked in the index.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || sections.length === 0) {
      return undefined;
    }

    const nodes = sections.map((section) => document.getElementById(section.id)).filter(Boolean);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setCurrent(visible[0].target.id);
        }
      },
      { rootMargin: "-10% 0px -60% 0px" }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [sections]);

  const jump = (event, id) => {
    const node = document.getElementById(id);
    if (!node) {
      return;
    }
    event.preventDefault();
    node.scrollIntoView({ block: "start", behavior: "smooth" });
    setCurrent(id);
    // Keyboard users land in the section too.
    const focusable = node.querySelector("input, select, textarea, button");
    focusable?.focus({ preventScroll: true });
  };

  return (
    <div className={`settings-layout ${className}`.trim()}>
      {sections.length > 0 && (
        <nav className="settings-index" aria-label={title}>
          <p className="settings-index-title">{title}</p>
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={current === section.id ? "is-current" : ""}
              aria-current={current === section.id ? "true" : undefined}
              onClick={(event) => jump(event, section.id)}
            >
              {section.label}
            </a>
          ))}
        </nav>
      )}
      <div className="settings-main">{children}</div>
    </div>
  );
}

// The bar at the bottom of a settings form.
//
// dirty      something has changed since the last save
// saving     a save is running
// savedAt    a Date (or true) once saved in this visit: "All changes saved"
// error      a short line when the last save failed
// onReset    shows "Undo changes" while dirty
// saveLabel  the button's words (default "Save changes"); the button is a
//            submit button, so it saves the surrounding <form>
// disabled   the person may not change settings: the bar says so instead
export function SettingsSaveBar({ dirty, saving, savedAt, error, onReset, saveLabel = "Save changes", disabled = false, children }) {
  const state = disabled ? "" : saving ? "is-saving" : dirty ? "is-dirty" : savedAt ? "is-saved" : "";
  const text = disabled
    ? "You can see these settings; changing them needs the settings permission."
    : error
      ? error
      : saving
        ? "Saving…"
        : dirty
          ? "You have unsaved changes"
          : savedAt
            ? "All changes saved"
            : "No changes yet";

  return (
    <div className={`settings-savebar ${state}`.trim()}>
      <span className="settings-savebar-status" role="status" aria-live="polite">
        {text}
      </span>
      {children}
      {!disabled && onReset && dirty && !saving && (
        <button type="button" className="button button-secondary" onClick={onReset}>
          Undo changes
        </button>
      )}
      {!disabled && (
        <button type="submit" className="button" disabled={saving || !dirty}>
          {saving ? "Saving…" : saveLabel}
        </button>
      )}
    </div>
  );
}
