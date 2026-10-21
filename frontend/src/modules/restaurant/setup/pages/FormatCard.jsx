import { useEffect, useState } from "react";
import Icon from "../../../../components/Icon";
import useConfirm from "../../../../hooks/useConfirm";
import api, { getErrorMessage } from "../../../../services/api";
import { formatIcon } from "../../../../services/restaurantFormats";

// What kind of place this is: a restaurant, a café, a bakery or a cloud
// kitchen. Choosing one sets how the POS opens, the token numbers and the
// features it needs; each of those can still be changed afterwards.

export default function FormatCard({ canChange, onChanged }) {
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    api.get("/restaurants/current/format").then((r) => { if (live) setData(r.data.data); }).catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [version]);

  const choose = async (format) => {
    const yes = await confirm({
      title: `Run as a ${format.label.toLowerCase()}?`,
      message: <p>{format.summary} The POS, token numbers and features are set for a {format.label.toLowerCase()}; you can change any of them afterwards. Nothing is deleted.</p>,
      confirmLabel: `Use ${format.label}`,
    });
    if (!yes) return;
    setBusy(format.code); setError("");
    try {
      const result = (await api.put("/restaurants/current/format", { format: format.code })).data;
      setVersion((n) => n + 1);
      await onChanged?.(result.message, result.data.skipped || []);
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(""); }
  };

  return (
    <section className="format-card" aria-label="Format">
      <header><strong>Format</strong><span className="muted">What kind of place this is.</span></header>
      {error && <p className="format-error" role="alert">{error}</p>}
      <div className="format-options">
        {(data?.formats || []).map((format) => {
          const current = data.code === format.code;
          return (
            <button key={format.code} type="button" className={`format-option ${current ? "is-current" : ""}`} disabled={!canChange || current || Boolean(busy)}
              aria-pressed={current} onClick={() => choose(format)}>
              <span className="format-icon"><Icon name={formatIcon(format.code)} size={20} /></span>
              <span className="format-text"><strong>{format.label}{current ? " · current" : ""}</strong><small>{format.summary}</small></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
