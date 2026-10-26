import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import LiveValue from "../../../../components/LiveValue";
import Modal from "../../../../components/Modal";
import useAuth from "../../../../hooks/useAuth";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { getErrorMessage } from "../../../../services/api";
import { getCollectionBoard, markTokenCollected } from "../services/order.service";
import { chimeReady, playChime, timeOfDay, unlockChime } from "../../../../services/kot";
import "../styles/collection.css";

// The collection screen: a TV by the pickup counter that shows the day's
// token numbers being made and ready to collect. It carries nothing but the
// numbers — no prices, no names, no mobiles — so it can face the guests.
//
// A TV signs in with the "Collection display" role, which can open nothing
// else. Counter staff (who take orders) can open it too, on a tablet, and
// tap a ready token to mark it handed over.

export default function CollectionDisplayPage() {
  const { user, hasPermission, logout } = useAuth();
  const staff = hasPermission("orders.create");
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [sound, setSound] = useState(false);
  const [fresh, setFresh] = useState({});
  const [collecting, setCollecting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const seen = useRef(null);
  const soundOn = useRef(false);

  const load = useCallback(
    () =>
      getCollectionBoard()
        .then((next) => {
          const before = seen.current;
          const readyNow = next.ready.map((row) => row.token);

          // A token that has just turned ready glows and chimes; the first
          // load and a token that was already ready do not.
          if (before) {
            const arrived = readyNow.filter((token) => !before.has(token));

            if (arrived.length > 0) {
              const until = Date.now() + 8000;

              setFresh((current) => {
                const copy = { ...current };

                for (const token of arrived) {
                  copy[token] = until;
                }

                return copy;
              });

              if (soundOn.current) {
                playChime();
              }
            }
          }

          seen.current = new Set(readyNow);
          setBoard(next);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    load();

    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, [load]);

  // Live: a token turns up within a second of the kitchen marking it ready,
  // and goes when it is handed over (live updates). As a safety net the
  // screen also reads itself every minute.
  const live = useLiveRefresh({ restaurant: true }, ["order", "kot", "business_day"], load);

  // A browser plays no sound until someone has touched the page.
  const turnOnSound = () => {
    unlockChime();
    soundOn.current = true;
    setSound(true);
    playChime();
  };

  const collect = async () => {
    const token = collecting;

    setBusy(true);

    try {
      const result = await markTokenCollected(token.orderId);

      setMessage(result.message);
      setCollecting(null);
      await load();
    } catch (err) {
      setMessage(getErrorMessage(err));
      setCollecting(null);
    } finally {
      setBusy(false);
    }
  };

  const ready = board ? board.ready : [];
  const preparing = board ? board.preparing : [];
  const place = board ? [board.restaurantName, board.outletName].filter(Boolean).join(" · ") : "";

  return (
    <main className="col-screen" aria-label="Order collection screen">
      <header className="col-head">
        <div className="col-brand">
          {staff && (
            <Link to="/orders" className="col-back">
              ← Back
            </Link>
          )}
          <span className="col-place">{place || user?.restaurantName || ""}</span>
        </div>
        <span className="col-clock" aria-label="Time now">
          {timeOfDay(now)}
        </span>
        <div className="col-tools">
          {!sound && (
            <button type="button" className="col-tool" onClick={turnOnSound}>
              Tap to turn on the chime
            </button>
          )}
          {sound && chimeReady() && <span className="col-tool is-on">Chime on</span>}
          <span className="col-tool is-quiet" data-live={live} title="Whether tokens appear here by themselves">
            {live === "live" ? "Live" : live === "reconnecting" ? "Reconnecting…" : live === "off" ? "Not live" : "Connecting…"}
          </span>
          {!staff && (
            <button type="button" className="col-tool is-quiet" onClick={logout}>
              Sign out
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="col-banner is-error" role="alert">
          Cannot reach the server — retrying. {error}
        </p>
      )}
      {message && (
        <p className="col-banner" role="status">
          {message}
        </p>
      )}
      {board && !board.tokensEnabled && (
        <p className="col-banner col-off">
          Token numbers are switched off, so no order has one.{" "}
          {hasPermission("orders.manage") ? (
            <Link to="/service/settings">Turn them on in Service settings.</Link>
          ) : (
            "A manager can turn them on in Service settings."
          )}
        </p>
      )}
      {board && !board.businessDate && (
        <p className="col-banner">No business day is open here yet, so there is nothing to show.</p>
      )}

      {/* Without tokens there is nothing to call out: one message, no empty boards. */}
      {!(board && !board.tokensEnabled) && (
      <div className="col-columns">
        <section className="col-column col-preparing" aria-label="Preparing">
          <h2 className="col-title">
            Preparing
            <span className="col-count">
              <LiveValue value={preparing.length} />
            </span>
          </h2>
          {preparing.length === 0 ? (
            <p className="col-empty">{board ? "Nothing being made right now" : "Loading…"}</p>
          ) : (
            <ul className="col-tokens">
              {preparing.map((row) => (
                <li key={row.token} className="col-token">
                  {row.token}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="col-column col-ready" aria-label="Ready for pickup" aria-live="polite">
          <h2 className="col-title">
            Ready for pickup
            <span className="col-count">
              <LiveValue value={ready.length} tone="success" />
            </span>
          </h2>
          {ready.length === 0 ? (
            <p className="col-empty">{board ? "Nothing waiting to be collected" : "Loading…"}</p>
          ) : (
            <ul className="col-tokens">
              {ready.map((row) => {
                const isFresh = (fresh[row.token] || 0) > now;

                return (
                  <li key={row.token} className={`col-token is-ready ${isFresh ? "is-new" : ""}`}>
                    {staff && row.orderId ? (
                      <button
                        type="button"
                        className="col-token-button"
                        onClick={() => setCollecting(row)}
                        title={`Mark token ${row.token} collected`}
                      >
                        {row.token}
                      </button>
                    ) : (
                      row.token
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {staff && ready.length > 0 && (
            <p className="col-hint">Tap a token when the guest has collected it. Ready tokens also clear by themselves after {board.clearMinutes} minutes.</p>
          )}
        </section>
      </div>
      )}

      {collecting && (
        <Modal title={`Token ${collecting.token} collected?`} onClose={() => setCollecting(null)} width={420}>
          <p>The guest has the parcel: token {collecting.token} leaves the Ready column on the screen.</p>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setCollecting(null)}>
              Not yet
            </button>
            <button type="button" className="button" onClick={collect} disabled={busy}>
              {busy ? "Saving…" : "Yes, collected"}
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
