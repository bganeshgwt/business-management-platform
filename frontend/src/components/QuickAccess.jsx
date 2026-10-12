import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import Icon from "./Icon";
import NavIcon from "./NavIcon";
import { pageAccent } from "../services/pageAccent";
import Modal from "./Modal";
import { ErrorMessage } from "./Feedback";
import { allowedQuickPaths, QUICK_ACCESS_LIMIT, quickAccessKey, readQuickAccess, writeQuickAccess } from "../services/navigationPreferences";
import "../styles/quick-access.css";

function QuickAccessEditor({ sections, selected, onSave, onClose }) {
  const [draft, setDraft] = useState(selected);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const dialogRef = useRef(null);
  const links = sections.flatMap(section => section.links);
  const paths = allowedQuickPaths(draft, links);
  const chosen = paths.map(path => links.find(link => link.to === path));
  const full = chosen.length >= QUICK_ACCESS_LIMIT;
  const term = search.trim().toLowerCase();
  const matches = sections.map(section => ({
    ...section,
    links: section.links.filter(link => `${section.title} ${link.label}`.toLowerCase().includes(term)),
  })).filter(section => section.links.length > 0);

  useEffect(() => {
    const trigger = document.activeElement;
    dialogRef.current.querySelector(".modal-close")?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);

  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
      .filter(node => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const toggle = (link) => {
    const exists = paths.includes(link.to);
    if (!exists && full) return;
    setDraft(exists ? paths.filter(path => path !== link.to) : [...paths, link.to]);
    setAnnouncement(`${link.label} ${exists ? "removed from" : "added to"} quick access.`);
    setError("");
  };

  const move = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= paths.length) return;
    const next = [...paths];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setDraft(next);
    setAnnouncement(`${chosen[index].label} moved to position ${nextIndex + 1} of ${paths.length}.`);
  };

  const save = () => {
    try {
      onSave(paths);
      onClose();
    } catch {
      setError("Your browser could not save these shortcuts. Allow site storage, then try again.");
    }
  };

  return (
    <div className="quick-editor-root" ref={dialogRef} onKeyDown={trapFocus}>
      <Modal title="Customize quick access" icon="star" width={620} onClose={onClose}
        description="Choose up to 5 pages and put them in the order you use them."
        footer={<>
          <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="button" onClick={save}><Icon name="check" size={16} />Save shortcuts</button>
        </>}
      >
        <ErrorMessage message={error} />
        <div className="quick-editor-heading">
          <h3>Your shortcuts <span>{chosen.length} / {QUICK_ACCESS_LIMIT}</span></h3>
          <button type="button" className="link-button" disabled={!paths.length}
            onClick={() => { setDraft([]); setAnnouncement("All shortcuts removed. Save to apply."); }}>Clear all</button>
        </div>
        {chosen.length ? (
          <ol className="quick-editor-selected" aria-label="Shortcut order">
            {chosen.map((link, index) => (
              <li key={link.to} data-accent={pageAccent(link.to)}>
                <span className="quick-editor-position" aria-hidden="true">{index + 1}</span>
                <NavIcon name={link.icon} />
                <span className="quick-editor-name">{link.label}</span>
                <div className="quick-editor-controls">
                  <button type="button" className="icon-button" disabled={index === 0}
                    aria-label={`Move ${link.label} up`} onClick={() => move(index, -1)}><Icon name="arrow-up" size={16} /></button>
                  <button type="button" className="icon-button" disabled={index === chosen.length - 1}
                    aria-label={`Move ${link.label} down`} onClick={() => move(index, 1)}><Icon name="arrow-down" size={16} /></button>
                  <button type="button" className="icon-button" aria-label={`Remove ${link.label} from quick access`}
                    onClick={() => toggle(link)}><Icon name="x" size={16} /></button>
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="quick-editor-empty">Select pages below to build your shortcut list.</p>}

        <label className="field quick-editor-search">
          <span>Find a page</span>
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Try POS, bills or stock" />
        </label>
        <p className="quick-editor-hint" id="quick-selection-help">
          {full ? "5 pages selected. Remove one to add a different page." : "Only pages your role can open are listed."}
        </p>
        <div className="quick-editor-choices" aria-describedby="quick-selection-help">
          {matches.map(section => (
            <fieldset key={section.title}>
              <legend>{section.title}</legend>
              {section.links.map(link => {
                const checked = paths.includes(link.to);
                return (
                  <label key={link.to} data-accent={pageAccent(link.to)} className={`quick-editor-choice${checked ? " is-selected" : ""}`}>
                    <input type="checkbox" checked={checked} disabled={full && !checked} onChange={() => toggle(link)} />
                    <NavIcon name={link.icon} />
                    <span>{link.label}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          {!matches.length && <p className="muted small">No pages match “{search}”. Try another name.</p>}
        </div>
        <p className="quick-editor-hint">Saved for your login in this browser. Other staff can choose their own shortcuts.</p>
        <span className="sr-only" role="status">{announcement}</span>
      </Modal>
    </div>
  );
}

// AppLayout keys this component by restaurant/user, so a PIN user switch also
// discards an unfinished editor and immediately loads the new user's choices.
// `scope` keeps a separate set of pinned pages per open business (a kirana's
// pins are not a restaurant's); left out, the restaurant's own set.
export default function QuickAccess({ user, sections, onNavigate, locked, scope }) {
  const storageKey = scope ? `${quickAccessKey(user)}:${scope}` : quickAccessKey(user);
  const [saved, setSaved] = useState(() => readQuickAccess(storageKey));
  const [editing, setEditing] = useState(false);
  const links = useMemo(() => sections.flatMap(section => section.links), [sections]);
  const selected = allowedQuickPaths(saved, links);

  useEffect(() => {
    const sync = (event) => {
      if (event.key === storageKey || event.key === null) setSaved(readQuickAccess(storageKey));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storageKey]);

  return (
    <section className="quick-access" aria-labelledby="quick-access-title">
      <div className="quick-access-heading">
        <h2 id="quick-access-title"><Icon name="star" size={14} />Quick access</h2>
        <button type="button" className="quick-access-edit" aria-label="Customize quick access" onClick={() => setEditing(true)}>
          <Icon name="edit" size={13} />{selected.length ? "Edit" : "Set up"}
        </button>
      </div>
      {selected.length ? (
        <nav className="quick-access-links" aria-label="Quick access">
          {selected.map(path => {
            const link = links.find(item => item.to === path);
            return <NavLink key={path} to={path} end={link.end} className="nav-link" data-accent={pageAccent(path)} onClick={onNavigate}>
              <NavIcon name={link.icon} /><span className="nav-label">{link.label}</span>
            </NavLink>;
          })}
        </nav>
      ) : <p className="quick-access-empty">Pin up to 5 pages for faster access.</p>}
      {editing && !locked && createPortal(
        <QuickAccessEditor sections={sections} selected={selected} onClose={() => setEditing(false)}
          onSave={paths => { const allowed = allowedQuickPaths(paths, links); writeQuickAccess(storageKey, allowed); setSaved(allowed); }} />,
        document.body
      )}
    </section>
  );
}
