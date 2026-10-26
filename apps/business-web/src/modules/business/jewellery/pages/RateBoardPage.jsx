import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { SESSION_WORDS, perGram } from "./jewellery";
import "../styles/jewellery.css";

// The rate board: today's rates in large type for a screen in the showroom.
// A new sheet shows within a second of being saved (live updates); the board
// also reads itself every minute, which turns it to the next day's rates
// after midnight. "Full screen" fills the screen with the board alone; the
// rates are the latest sheet of the day for each purity.

export default function RateBoardPage() {
  const biz = useOpenBusiness();
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const area = useRef(null);
  const reader = useRef(null);
  useEffect(() => {
    let controller = null;
    const read = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      businessRead(biz.id, "jewellery/rates/today", undefined, signal)
        .then((d) => { setBoard(d); setError(""); })
        .catch((err) => { if (!signal.aborted) setError(getErrorMessage(err)); });
    };
    reader.current = read;
    read();
    return () => { reader.current = null; controller?.abort(); };
  }, [biz.id]);
  const live = useLiveRefresh({ business: biz.id }, ["jewellery_rates"], () => reader.current?.());
  const fullScreen = () => area.current?.requestFullscreen?.().catch(() => {});

  if (!board) return <div className="stack"><BusinessHeader icon="grid" title="Rate board" actions={<LiveIndicator status={live} />} /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const shop = board.seller?.display_name || biz.settings.display_name || biz.business.name;
  const latest = board.rates.reduce((at, r) => (!at || r.set_at > at.set_at ? r : at), null);
  return (
    <div className="stack">
      <BusinessHeader icon="grid" title="Rate board" description="Today's rates in large type for a screen in the showroom. A new sheet of rates shows here as soon as it is saved."
        actions={<LiveIndicator status={live} />}
        primary={<button type="button" className="button" onClick={fullScreen}><Icon name="external" size={16} /> Full screen</button>}
        secondary={<Link className="button button-secondary" to={biz.path("gold-rates")}><Icon name="tag" size={15} /> Today's rates</Link>} />
      <ErrorMessage message={error} />
      <section ref={area} className="jw-board" aria-label="Today's rates">
        <header className="jw-board-head">
          <span className="jw-board-shop">{shop}</span>
          <span className="jw-board-day">{dateShort(board.day, { year: true })}{latest ? ` · ${SESSION_WORDS[latest.session] || ""}` : ""}</span>
        </header>
        {board.rates.length === 0 ? <p className="jw-board-empty">Today's rates are not set yet.</p> : (
          <table className="jw-board-table">
            <thead><tr><th scope="col">Purity</th><th scope="col">Rate per gram</th><th scope="col">Old gold &amp; silver bought at</th></tr></thead>
            <tbody>
              {board.rates.map((r) => (
                <tr key={`${r.metal}:${r.purity}`} className={`jw-board-${r.metal}`}>
                  <th scope="row">{r.label}</th>
                  <td><span className="jw-board-rate">{perGram(biz, r.sell_rate)}</span>{r.metal === "gold" && <span className="jw-board-ten">10 g {biz.exact(Number(r.sell_rate) * 10).replace(/\.00$/, "")}</span>}</td>
                  <td>{r.buy_rate ? <span className="jw-board-buy">{perGram(biz, r.buy_rate)}</span> : <span className="jw-board-none">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <footer className="jw-board-foot">Rates per gram before making charges and GST.{latest ? ` Updated ${new Date(latest.set_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: biz.business.timezone || "Asia/Kolkata" })}.` : ""}</footer>
      </section>
    </div>
  );
}
