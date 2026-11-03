import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { useDirtyGuard, useOpenBusiness } from "./hooks";
import "../../../../styles/words.css";

// Business settings › Words: the kind of business (a yoga studio among gyms,
// studios and coaching), and the words its screens, bills and messages use
// for its people, things and places. Each starts as its type's word (the
// kind's, where the kind has its own), as the platform sets them; the owner
// may write their own, and go back to the type's. Legal and tax words (GSTIN,
// Tax invoice, HSN) are not here: the law names them.
export default function WordsCard() {
  const biz = useOpenBusiness();
  const editable = biz.can("settings.edit");
  const [view, setView] = useState(null);
  const [kind, setKind] = useState("");
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = (data) => {
    setView(data);
    setKind(data.kind || "");
    setDraft(Object.fromEntries(data.words.map((w) => [w.key, { one: w.own?.one || "", many: w.own?.many || "" }])));
  };
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "words", undefined, controller.signal).then(load)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);

  // The word each key has without the owner's own: its kind's, else its type's.
  const standard = (word) => (kind && word.kindWords[kind]) || word.typeWord;
  const changes = useMemo(() => {
    if (!view) return null;
    const words = {};
    for (const word of view.words) {
      const typed = draft[word.key] || { one: "", many: "" };
      const one = typed.one.trim();
      const many = typed.many.trim();
      const before = word.own;
      if (!one && !many) { if (before) words[word.key] = null; continue; }
      if (!before || before.one !== one || before.many !== many) words[word.key] = { one, many };
    }
    const kindChanged = (view.kind || "") !== kind;
    return { words, kindChanged, count: Object.keys(words).length + (kindChanged ? 1 : 0) };
  }, [view, draft, kind]);
  useDirtyGuard(Boolean(changes?.count));

  const word = (key, form = "one") => {
    const entry = view?.words.find((w) => w.key === key);
    if (!entry) return biz.t(key, form);
    const typed = draft[key];
    const own = typed && typed.one.trim() ? { one: typed.one.trim(), many: typed.many.trim() || typed.one.trim() } : null;
    const chosen = own || standard(entry);
    return form === "many" ? chosen.many : chosen.one;
  };

  const save = async (event) => {
    event.preventDefault();
    const missing = Object.entries(changes.words).find(([, value]) => value && (!value.one || !value.many));
    if (missing) {
      setError(`${view.words.find((w) => w.key === missing[0]).label}: write the word and its plural, or clear both to use your type's.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await businessWrite(biz.id, "words", { ...(changes.kindChanged ? { kind: kind || null } : {}), words: changes.words }, "put");
      load(saved);
      toast.success("Words saved. Every screen uses them now.");
      biz.reloadContext();
      if (changes.kindChanged) biz.reloadDirectory();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const current = view?.kinds.find((k) => k.code === kind);
  return (
    <SectionCard id="bz-settings-words" icon="edit" title="Words"
      description="What your screens, bills and messages call your people, things and places. Each starts as your type's word; write your own where your business says it differently.">
      <ErrorMessage message={error} />
      {!view && !error && <Loading />}
      {view && (
        <form className="stack words-form" onSubmit={save}>
          <fieldset className="bz-plain-fieldset" disabled={!editable || busy}>
            {view.kinds.length > 0 && (
              <div className="words-kind">
                <span className={`words-kind-mark type-accent-${biz.look?.accent || "teal"}`} aria-hidden="true">
                  <Icon name={current?.icon || biz.look?.icon} fallback="store" size={20} />
                </span>
                <label className="field">
                  <span>Kind of business</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="">Not chosen (the type's own words)</option>
                    {view.kinds.map((k) => <option key={k.code} value={k.code}>{k.name}{k.active ? "" : " (no longer offered)"}</option>)}
                  </select>
                  <small className="muted">A kind brings its own words: a coaching centre's students and classes, a spa's guests and therapists. Your own words stay.</small>
                </label>
              </div>
            )}
            <div className="words-preview" aria-label="How your menu reads">
              <span className="muted small">Your menu reads</span>
              {["customer_list", "catalog", "appointment", "resource", "dues_list", "collection"].map((key) => (
                <span key={key} className="words-chip">{word(key, "many")}</span>
              ))}
            </div>
            <ul className="words-list">
              {view.words.map((w) => {
                const base = standard(w);
                const typed = draft[w.key] || { one: "", many: "" };
                const own = Boolean(typed.one || typed.many);
                const set = (field) => (e) => setDraft((d) => ({ ...d, [w.key]: { ...typed, [field]: e.target.value } }));
                return (
                  <li key={w.key} className={`words-row${own ? " is-own" : ""}`}>
                    <div className="words-row-head">
                      <strong>{w.label}</strong>
                      <small className="muted">{w.hint}</small>
                    </div>
                    <div className="words-row-fields">
                      <label className="field">
                        <span>Word</span>
                        <input maxLength={80} value={typed.one} placeholder={base.one} onChange={set("one")} aria-label={`${w.label}: the word`} />
                      </label>
                      <label className="field">
                        <span>Plural</span>
                        <input maxLength={80} value={typed.many} placeholder={base.many} onChange={set("many")} aria-label={`${w.label}: its plural`} />
                      </label>
                      {own && editable && (
                        <button type="button" className="button button-ghost button-sm words-reset" onClick={() => setDraft((d) => ({ ...d, [w.key]: { one: "", many: "" } }))}>
                          <Icon name="undo" size={14} /> Use “{base.one}”
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {editable && (
            <div className="words-actions">
              <span className="muted small">{changes.count ? `${changes.count} change${changes.count === 1 ? "" : "s"} not saved` : "Nothing to save"}</span>
              <button type="submit" className="button" disabled={busy || !changes.count}>{busy ? "Saving…" : "Save words"}</button>
            </div>
          )}
        </form>
      )}
    </SectionCard>
  );
}
