import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { BUSINESS_ICONS } from "@bmp/ui/businessIcons";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import Modal from "../../../components/Modal";
import { consoleBusinessType, saveConsoleBusinessKind, saveConsoleBusinessModule, saveConsoleBusinessType } from "../services/console.service";
import "../styles/console.css";
import "../../../styles/words.css";

// Platform › Business types › one type (/platform/business-types/:code): its
// name, mark and accent, the kind a new item starts as; its kinds; and the
// words its businesses see, for the type and for each kind. A word left
// empty is the default (for a kind: the type's); an owner may still rename
// the words marked so, for their own business.
const AREAS = [
  ["people", "People"], ["things", "What is sold"], ["places", "Places"], ["work", "Work"], ["money", "Money"], ["examples", "Examples and printed lines"],
];
const PREVIEW = ["customer_list", "catalog", "appointment", "resource", "dues_list", "collection"];

// A scope's words as the editor holds them: the type's ("") or a kind's.
const draftOf = (words, scope) => Object.fromEntries(words.map((w) => {
  const stored = scope ? w.kinds[scope] : w.type;
  return [w.key, { one: stored?.one || "", many: stored?.many || "", none: Boolean(stored && !w.plural && stored.one === "") }];
}));

export default function PlatformBusinessTypePage() {
  const { code } = useParams();
  // A fresh editor for each type.
  return <TypeEditor key={code} code={code} />;
}

function TypeEditor({ code }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [look, setLook] = useState(null);
  const [scope, setScope] = useState("");
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const load = (fresh) => {
    setData(fresh);
    setLook({ name: fresh.type.name, icon: fresh.type.icon, accent: fresh.type.accent, defaultItemKind: fresh.type.defaultItemKind });
    setDrafts(Object.fromEntries(["", ...fresh.type.kinds.map((k) => k.code)].map((s) => [s, draftOf(fresh.words, s)])));
  };
  useEffect(() => {
    consoleBusinessType(code).then(load).catch((err) => setError(getErrorMessage(err)));
  }, [code]);

  // What a scope's draft changes: { key: { one, many } | null }.
  const changesOf = (s) => {
    if (!data || !drafts[s]) return {};
    const out = {};
    for (const w of data.words) {
      const stored = s ? w.kinds[s] || null : w.type;
      const d = drafts[s][w.key];
      let value;
      if (!w.plural && d.none) value = { one: "" };
      else if (!d.one.trim() && !d.many.trim()) value = null;
      else value = w.plural ? { one: d.one.trim(), many: d.many.trim() } : { one: d.one.trim() };
      const same = value === null ? stored === null : stored !== null && stored.one === value.one && (!w.plural || stored.many === value.many);
      if (!same) out[w.key] = value;
    }
    return out;
  };
  const typeChanges = changesOf("");
  const scopeChanges = changesOf(scope);
  const lookChanged = data && look && ["name", "icon", "accent", "defaultItemKind"].some((k) => look[k] !== data.type[k]);
  const unsaved = Object.keys(scopeChanges).length + (!scope && lookChanged ? 1 : 0);

  // A word as businesses of this scope would see it, with the draft in.
  const shown = (key, form = "one") => {
    const w = data.words.find((x) => x.key === key);
    const d = drafts[scope]?.[key];
    const typeWord = (() => {
      const t = drafts[""]?.[key];
      if (t && t.one.trim()) return { one: t.one.trim(), many: t.many.trim() };
      return w.standard;
    })();
    const word = d && d.one.trim() ? { one: d.one.trim(), many: d.many.trim() } : scope ? typeWord : w.standard;
    return form === "many" ? word.many || word.one : word.one;
  };

  const save = async (event) => {
    event.preventDefault();
    const missing = Object.entries(scopeChanges).find(([key, value]) => value && data.words.find((w) => w.key === key).plural && (!value.one || !value.many));
    if (missing) {
      setError(`${data.words.find((w) => w.key === missing[0]).label}: write the word and its plural, or clear both.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fresh = scope
        ? await saveConsoleBusinessKind(code, scope, { words: scopeChanges })
        : await saveConsoleBusinessType(code, { ...look, words: typeChanges });
      load(fresh);
      toast.success(scope ? "The kind's words are saved. Its businesses see them now." : "Saved. Every business of this type sees it now.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data || !look) {
    return (
      <div className="stack pc-page">
        <PageHeader icon="grid" eyebrow="Platform › Business types" title="Business type" />
        <ErrorMessage message={error} />
        {!error && <Loading />}
      </div>
    );
  }
  const kinds = data.type.kinds;
  const current = kinds.find((k) => k.code === scope);
  const setWord = (key, field) => (e) => setDrafts((all) => ({ ...all, [scope]: { ...all[scope], [key]: { ...all[scope][key], [field]: field === "none" ? e.target.checked : e.target.value } } }));
  return (
    <div className="stack pc-page">
      <PageHeader icon="grid" eyebrow="Platform › Business types" title={data.type.name}
        description={`${data.type.businesses === 1 ? "1 business" : `${data.type.businesses} businesses`} of this type. What you save here, they see at once; an owner's own words stay theirs.`}
        actions={<Link className="button button-secondary" to="/platform/business-types"><Icon name="arrow-left" size={15} /> All types</Link>} />
      <ErrorMessage message={error} />
      <form className="stack" onSubmit={save}>
        <SectionCard icon="sparkles" title="Name and look" description="The type's name in the switcher, the sign-up and the price list; its mark and its colour wherever a business of it shows.">
          <div className="bt-look">
            <div className="bt-look-fields">
              <label className="field">
                <span>Name</span>
                <input required maxLength={80} value={look.name} onChange={(e) => setLook((l) => ({ ...l, name: e.target.value }))} disabled={Boolean(scope)} />
              </label>
              <fieldset className="bt-choice" disabled={Boolean(scope)}>
                <legend>A new item starts as</legend>
                {[["goods", "Goods, kept in stock"], ["service", "A service"]].map(([value, label]) => (
                  <label key={value} className="checkbox bz-check">
                    <input type="radio" name="item-kind" value={value} checked={look.defaultItemKind === value} onChange={() => setLook((l) => ({ ...l, defaultItemKind: value }))} /> {label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="bt-choice" disabled={Boolean(scope)}>
                <legend>Colour</legend>
                <div className="bt-swatches">
                  {data.accents.map((accent) => (
                    <label key={accent} className={`bt-swatch type-accent-${accent}${look.accent === accent ? " is-on" : ""}`} title={accent}>
                      <input type="radio" name="accent" value={accent} checked={look.accent === accent} onChange={() => setLook((l) => ({ ...l, accent }))} aria-label={accent} />
                      <span className="accent-swatch" aria-hidden="true" />
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="bt-preview" aria-label="How it looks">
              <span className={`bt-mark type-accent-${look.accent}`} aria-hidden="true"><Icon name={(current?.icon) || look.icon} fallback="store" size={24} /></span>
              <div>
                <strong>{current ? current.name : look.name}</strong>
                <div className="words-preview">
                  {PREVIEW.map((key) => <span key={key} className="words-chip">{shown(key, "many")}</span>)}
                </div>
              </div>
            </div>
          </div>
          <fieldset className="bt-choice" disabled={Boolean(scope)}>
            <legend>Mark</legend>
            <div className="bt-icons">
              {BUSINESS_ICONS.map((name) => (
                <button key={name} type="button" className={`bt-icon${look.icon === name ? " is-on" : ""}`} aria-pressed={look.icon === name} title={name}
                  onClick={() => setLook((l) => ({ ...l, icon: name }))}>
                  <Icon name={name} size={20} />
                </button>
              ))}
            </div>
          </fieldset>
        </SectionCard>

        <Kinds key={kinds.map((k) => `${k.code}:${k.name}:${k.icon}:${k.active}`).join("|")} code={code} kinds={kinds} typeIcon={look.icon} onSaved={load} />

        <SectionCard icon="edit" title="Words"
          description="Empty: the default (for a kind, the type's). The words marked “owners rename” an owner may still change for their own business.">
          {kinds.length > 0 && (
            <div className="bt-scope" role="group" aria-label="Words of">
              {[["", `The type: ${data.type.name}`], ...kinds.map((k) => [k.code, k.name])].map(([value, label]) => (
                <button key={value || "type"} type="button" className={`bt-scope-option${scope === value ? " is-on" : ""}`} aria-pressed={scope === value}
                  onClick={() => setScope(value)}>{label}{Object.keys(changesOf(value)).length || (!value && lookChanged) ? " •" : ""}</button>
              ))}
            </div>
          )}
          {AREAS.map(([area, title]) => {
            const rows = data.words.filter((w) => w.area === area);
            return (
              <div key={area} className="bt-area">
                <h3>{title}</h3>
                <ul className="words-list">
                  {rows.map((w) => {
                    const d = drafts[scope][w.key];
                    const fallback = scope ? (w.type || w.standard) : w.standard;
                    const own = Boolean(d.one || d.many || d.none);
                    return (
                      <li key={w.key} className={`words-row${own ? " is-own" : ""}`}>
                        <div className="words-row-head">
                          <strong>{w.label}{w.ownerMayRename && <span className="bt-tag">owners rename</span>}</strong>
                          <small className="muted">{w.hint}{w.renamedBy ? ` ${w.renamedBy === 1 ? "1 business has" : `${w.renamedBy} businesses have`} its own.` : ""}</small>
                        </div>
                        <div className="words-row-fields">
                          <label className="field">
                            <span>{w.plural ? "Word" : "Text"}</span>
                            <input maxLength={w.plural ? 80 : 300} value={d.one} placeholder={fallback.one || "(none)"} disabled={d.none} onChange={setWord(w.key, "one")}
                              aria-label={`${w.label}: ${w.plural ? "the word" : "the text"}`} />
                          </label>
                          {w.plural ? (
                            <label className="field">
                              <span>Plural</span>
                              <input maxLength={80} value={d.many} placeholder={fallback.many} onChange={setWord(w.key, "many")} aria-label={`${w.label}: its plural`} />
                            </label>
                          ) : (
                            <label className="checkbox bz-check bt-none">
                              <input type="checkbox" checked={d.none} onChange={setWord(w.key, "none")} /> None
                            </label>
                          )}
                          {own && (
                            <button type="button" className="button button-ghost button-sm words-reset"
                              onClick={() => setDrafts((all) => ({ ...all, [scope]: { ...all[scope], [w.key]: { one: "", many: "", none: false } } }))}>
                              <Icon name="undo" size={14} /> Default
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </SectionCard>
        <div className={`pc-savebar${unsaved ? " has-changes" : ""}`}>
          <span className="pc-savebar-text">
            {unsaved ? `${unsaved} ${unsaved === 1 ? "change" : "changes"} not saved yet` : current ? `Editing the words of ${current.name}` : "Nothing changed"}
          </span>
          <button type="submit" className="button" disabled={busy || !unsaved}>{busy ? "Saving…" : current ? `Save ${current.name}'s words` : "Save the type"}</button>
        </div>
      </form>
      {/* Saved one at a time: words being written above stay as they are. */}
      {data.modules && <Modules code={code} typeName={data.type.name} modules={data.modules} onSaved={(fresh) => setData((d) => ({ ...d, modules: fresh.modules }))} />}
    </div>
  );
}

// The type's optional modules, each saved as it is switched: offered to its
// businesses (at sign-up, in Business tools and in Your plan) or not,
// recommended (listed first, with why) and on at start for a new business. Not
// offered, its new businesses never see it; those that have it on keep it.
function Modules({ code, typeName, modules, onSaved }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // The module being recommended, and why (owners read it in Business tools).
  const [asking, setAsking] = useState(null);
  const [reason, setReason] = useState("");
  const names = Object.fromEntries(modules.map((m) => [m.code, m.name]));
  const offeredCount = modules.filter((m) => m.offered).length;
  // The switch as asked while it is being saved: it moves at once, and back if refused.
  const [asked, setAsked] = useState(null);
  const shownOf = (m, key) => (asked && asked.code === m.code && asked.body[key] !== undefined ? asked.body[key] : m[key]);
  const send = async (m, body, done) => {
    setBusy(m.code);
    setAsked({ code: m.code, body });
    setError("");
    try {
      onSaved(await saveConsoleBusinessModule(code, m.code, body));
      toast.success(done);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy("");
      setAsked(null);
    }
  };
  const recommend = async (event) => {
    event.preventDefault();
    if (await send(asking, { recommended: true, recommendedNote: reason.trim() }, `${asking.name} is recommended for ${typeName}.`)) setAsking(null);
  };
  return (
    <SectionCard icon="grid" title="Modules"
      description={`What ${typeName} businesses may switch on, beyond what every business has: ${offeredCount} of ${modules.length} offered. Not offered: its new businesses never see it at sign-up, in Business tools or in Your plan; those that have it on keep it.`}>
      <ErrorMessage message={error} />
      <ul className="bt-modules">
        {modules.map((m) => (
          <li key={m.code} className={`bt-module${m.offered ? "" : " is-off"}`}>
            <div className="bt-module-text">
              <strong>{m.name}</strong>
              {m.description && <small className="muted">{m.description}</small>}
              {m.requires.length > 0 && <small className="muted">Needs {m.requires.map((c) => names[c] || c).join(", ")}.</small>}
              {m.recommended && m.recommendedNote && <small className="bt-module-why">Recommended: {m.recommendedNote}</small>}
              {m.inUse > 0 && (
                <small className={m.offered ? "muted" : "bt-module-kept"}>
                  {m.inUse === 1 ? "1 business" : `${m.inUse} businesses`} of this type {m.inUse === 1 ? "has" : "have"} it on{m.offered ? "" : " and keep it"}.
                </small>
              )}
            </div>
            <div className="bt-module-switches" role="group" aria-label={`${m.name} for ${typeName}`}>
              <label className="checkbox bz-check">
                <input type="checkbox" checked={shownOf(m, "offered")} disabled={Boolean(busy)}
                  onChange={(e) => send(m, { offered: e.target.checked }, e.target.checked ? `${m.name} is offered to ${typeName}.` : `${m.name} is no longer offered to new ${typeName} businesses.`)} />
                Offered
              </label>
              <label className="checkbox bz-check">
                <input type="checkbox" checked={shownOf(m, "recommended")} disabled={Boolean(busy) || !shownOf(m, "offered")}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setReason(m.recommendedNote || "");
                      setAsking(m);
                    } else send(m, { recommended: false }, `${m.name} is no longer recommended.`);
                  }} />
                Recommended
              </label>
              <label className="checkbox bz-check">
                <input type="checkbox" checked={shownOf(m, "onAtStart")} disabled={Boolean(busy) || !shownOf(m, "offered")}
                  onChange={(e) => send(m, { onAtStart: e.target.checked }, e.target.checked ? `A new ${typeName} business starts with ${m.name} on.` : `A new ${typeName} business starts with ${m.name} off.`)} />
                On at start
              </label>
            </div>
          </li>
        ))}
      </ul>
      {asking && (
        <Modal title={`Recommend ${asking.name}`} icon="sparkles" width={520} onClose={() => setAsking(null)}
          description={`Listed first for ${typeName}, with a Recommended badge and this reason, at sign-up and in Business tools.`}>
          <form className="form-grid" onSubmit={recommend}>
            <label className="field field-wide">
              <span>Why {typeName} businesses use it</span>
              <input required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. For function and office orders" autoFocus />
            </label>
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setAsking(null)}>Cancel</button>
              <button type="submit" className="button" disabled={busy === asking.code}>Recommend it</button>
            </div>
          </form>
        </Modal>
      )}
    </SectionCard>
  );
}

// The type's kinds: each one's name, mark and whether a new business may
// choose it; and a new kind. A kind switched off stays on the businesses that
// have it.
function Kinds({ code, kinds, typeIcon, onSaved }) {
  const [rows, setRows] = useState(() => Object.fromEntries(kinds.map((k) => [k.code, { name: k.name, icon: k.icon || "", active: k.active }])));
  const [fresh, setFresh] = useState({ name: "", code: "", icon: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const send = async (kindCode, body, done) => {
    setBusy(kindCode);
    setError("");
    try {
      onSaved(await saveConsoleBusinessKind(code, kindCode, body));
      toast.success(done);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy("");
    }
  };
  const codeFrom = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return (
    <SectionCard icon="layers" title="Kinds" description="Kinds within this type, each with its own mark and, below, its own words: a yoga studio's teachers and classes among gyms. Off: no new business can choose it; those that have it keep it.">
      <ErrorMessage message={error} />
      {kinds.length === 0 && <p className="muted">No kinds yet: every business of this type uses the type's words.</p>}
      <ul className="bt-kind-list">
        {kinds.map((k) => {
          const row = rows[k.code] || { name: k.name, icon: k.icon || "", active: k.active };
          const changed = row.name !== k.name || row.icon !== (k.icon || "") || row.active !== k.active;
          const set = (field, value) => setRows((all) => ({ ...all, [k.code]: { ...row, [field]: value } }));
          return (
            <li key={k.code} className="bt-kind-row">
              <span className="bt-kind-mark" aria-hidden="true"><Icon name={row.icon || typeIcon} fallback="store" size={18} /></span>
              <label className="field">
                <span>Name</span>
                <input maxLength={80} value={row.name} onChange={(e) => set("name", e.target.value)} />
              </label>
              <label className="field">
                <span>Mark</span>
                <select value={row.icon} onChange={(e) => set("icon", e.target.value)}>
                  <option value="">The type's</option>
                  {BUSINESS_ICONS.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="checkbox bz-check">
                <input type="checkbox" checked={row.active} onChange={(e) => set("active", e.target.checked)} /> On offer
              </label>
              <small className="muted">{k.businesses === 1 ? "1 business" : `${k.businesses} businesses`}</small>
              <button type="button" className="button button-secondary button-sm" disabled={!changed || busy === k.code}
                onClick={() => send(k.code, { name: row.name, icon: row.icon || null, active: row.active }, `${row.name} saved.`)}>
                {busy === k.code ? "Saving…" : "Save"}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="bt-kind-new">
        <label className="field">
          <span>A new kind</span>
          <input maxLength={80} value={fresh.name} placeholder="e.g. CrossFit box"
            onChange={(e) => setFresh((f) => ({ ...f, name: e.target.value, code: f.code && f.code !== codeFrom(f.name) ? f.code : codeFrom(e.target.value) }))} />
        </label>
        <label className="field">
          <span>Its code</span>
          <input maxLength={40} className="mono" value={fresh.code} onChange={(e) => setFresh((f) => ({ ...f, code: e.target.value }))} placeholder="crossfit_box" />
        </label>
        <label className="field">
          <span>Mark</span>
          <select value={fresh.icon} onChange={(e) => setFresh((f) => ({ ...f, icon: e.target.value }))}>
            <option value="">The type's</option>
            {BUSINESS_ICONS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="button button-sm" disabled={!fresh.name.trim() || !fresh.code || Boolean(busy)}
          onClick={async () => { if (await send(fresh.code, { name: fresh.name, icon: fresh.icon || null }, `${fresh.name} added.`)) setFresh({ name: "", code: "", icon: "" }); }}>
          <Icon name="plus" size={14} /> Add the kind
        </button>
      </div>
    </SectionCard>
  );
}
