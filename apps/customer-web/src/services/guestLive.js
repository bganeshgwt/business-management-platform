import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../shared/publicClient";
import { liveAddress, retryDelay, sameScope, SILENT_MS, usableKey } from "./guestLiveRules";

// A guest page's live updates (docs/ARCHITECTURE.md › Live updates, "Guests'
// streams").
//
//   const status = useGuestLive(live, reload, { safetyNetMs, fallbackMs });
//
// `live` is the { key, expiresAt } the page's last status answer carried (null
// when nothing more can happen to what it shows); `reload` reads the status
// again and returns a promise (its answer brings the next `live`). The hook:
//   - opens GET /api/public/live?key=… with the browser's EventSource (a guest
//     sends no headers), reads once as it opens (a change made while it was
//     opening was not heard), and again a moment after each change it hears
//     of (a burst is one read, never two at once);
//   - keeps that stream while new answers watch the same rows, and opens a new
//     one when they watch others (a new order joined the table's list);
//   - reads again when the stream ends (its key ran out, the server
//     restarted): the answer brings a fresh key, and the stream opens again;
//   - while no stream is open (it cannot open, a proxy holds it back, the
//     network dropped, the server is full), reads on its own every
//     `fallbackMs` and tries the stream again after 5, 10, 20, 40 seconds,
//     then every minute, so the page is never left waiting on a stream;
//   - while a stream is open, still reads every `safetyNetMs` (a minute), in
//     case a change was missed;
//   - closes the stream while the page is hidden, and reads again and reopens
//     when it is shown;
//   - takes a stream silent for 70 seconds as dropped.
// It returns "live" (a stream is open and heard from), "connecting",
// "polling" (reading every few seconds instead), "paused" (hidden) or "off"
// (nothing to follow), for the page's LiveDot.

const DEBOUNCE_MS = 300;
// A stream that has not said "ready" this long after opening is held back
// somewhere (a proxy buffering it): the page reads on its own instead.
const READY_WITHIN_MS = 10000;

function createFollower({ getLive, reload, options, setStatus }) {
  let source = null;
  let openedKey = null;
  let heardAt = 0;
  let attempts = 0;
  let stopped = false;
  let waitingForKey = false;
  const timers = { retry: null, poll: null, net: null, debounce: null, watch: null };
  let reading = false;
  let readAgain = false;
  let shown = "off";

  const show = (status) => {
    if (status !== shown) {
      shown = status;
      setStatus(status);
    }
  };
  const clear = (name) => {
    clearTimeout(timers[name]);
    timers[name] = null;
  };
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

  // One read at a time: a change heard during a read asks for one more.
  const read = async () => {
    if (stopped) {
      return;
    }

    if (reading) {
      readAgain = true;
      return;
    }

    reading = true;

    try {
      await reload();
    } catch {
      // The page shows its own error; the next change, poll or safety net reads again.
    } finally {
      reading = false;
    }

    if (readAgain && !stopped) {
      readAgain = false;
      read();
    }
  };

  const soon = () => {
    clear("debounce");
    timers.debounce = setTimeout(read, DEBOUNCE_MS);
  };

  // Reading on its own while no stream is open; the safety net while one is.
  const poll = () => {
    clear("poll");
    timers.poll = setTimeout(() => {
      if (!hidden()) {
        read();
      }

      poll();
    }, options().fallbackMs);
  };
  const net = () => {
    clear("net");
    timers.net = setTimeout(() => {
      if (!hidden()) {
        read();
      }

      net();
    }, options().safetyNetMs);
  };

  const close = () => {
    if (source) {
      source.close();
      source = null;
    }

    openedKey = null;
    clear("watch");
  };

  // Every timer and the stream stop (hidden, unmounted, or nothing to follow).
  const rest = () => {
    close();

    for (const name of Object.keys(timers)) {
      clear(name);
    }
  };

  const retryLater = () => {
    if (stopped || timers.retry) {
      return;
    }

    timers.retry = setTimeout(() => {
      timers.retry = null;
      open();
    }, retryDelay(attempts));
    attempts += 1;
  };

  // The stream did not work, or stopped: read on its own and try again later.
  const fallBack = () => {
    close();
    clear("net");

    if (!timers.poll) {
      poll();
    }

    show("polling");
    retryLater();
  };

  function open() {
    clear("retry");
    const live = getLive();

    if (stopped || hidden()) {
      return;
    }

    if (!live || !live.key) {
      rest();
      show("off");
      return;
    }

    // An old key (a tab woken after hours): a fresh read brings a new one.
    if (!usableKey(live)) {
      close();
      waitingForKey = true;
      show("connecting");

      if (!timers.poll) {
        poll();
      }

      read();
      return;
    }

    if (typeof window === "undefined" || typeof window.EventSource !== "function") {
      show("polling");

      if (!timers.poll) {
        poll();
      }

      return;
    }

    close();
    waitingForKey = false;
    // A stream taking over from a live one (the page now watches other rows)
    // keeps the page "Live": its dot never flickers.
    show(shown === "polling" || shown === "live" ? shown : "connecting");

    // Reading on its own until the stream says it is ready.
    if (!timers.poll) {
      poll();
    }

    const stream = new window.EventSource(liveAddress(API_BASE, live.key));
    source = stream;
    openedKey = live.key;
    heardAt = Date.now();
    let ready = false;
    const mine = () => source === stream;
    const heard = () => {
      heardAt = Date.now();
    };

    // Listening: what changed while the stream was opening was not heard,
    // so the page reads once, now.
    stream.addEventListener("ready", () => {
      if (!mine()) return;
      heard();
      ready = true;
      attempts = 0;
      clear("poll");
      net();
      read();
      show("live");
    });
    stream.addEventListener("change", () => {
      if (!mine()) return;
      heard();
      soon();
    });
    stream.addEventListener("resync", () => {
      if (!mine()) return;
      heard();
      soon();
    });
    stream.addEventListener("ping", () => {
      if (mine()) heard();
    });
    // Its key ran out, or the server is restarting: a fresh read brings the
    // next key, and the stream opens again with it.
    stream.addEventListener("end", () => {
      if (!mine()) return;
      fallBack();
      waitingForKey = true;
      read();
    });
    // EventSource would try again by itself, with the same key: the page
    // decides instead.
    stream.onerror = () => {
      if (mine()) fallBack();
    };

    // Ready within ten seconds, then heard from at least every 70.
    const watch = () => {
      clear("watch");
      timers.watch = setTimeout(() => {
        if (!mine()) return;
        const limit = ready ? SILENT_MS : READY_WITHIN_MS;

        if (Date.now() - heardAt >= limit) {
          fallBack();
        } else {
          watch();
        }
      }, 5000);
    };
    watch();
  }

  // A new status answer.
  const update = (live) => {
    if (stopped) {
      return;
    }

    if (!live || !live.key) {
      rest();
      show("off");
      return;
    }

    if (hidden()) {
      return;
    }

    if (source && sameScope(openedKey, live.key)) {
      return;
    }

    if (source || waitingForKey || !timers.retry) {
      open();
    }
  };

  const onVisibility = () => {
    if (stopped) {
      return;
    }

    if (hidden()) {
      rest();
      show(getLive() ? "paused" : "off");
      return;
    }

    attempts = 0;
    read();
    open();
  };

  // Back online: try the stream now rather than at its next turn.
  const onOnline = () => {
    if (!stopped && !source && getLive()) {
      attempts = 0;
      open();
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);

  return {
    update,
    stop: () => {
      stopped = true;
      rest();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    },
  };
}

export function useGuestLive(live, onChange, { safetyNetMs = 60000, fallbackMs = 20000 } = {}) {
  const [status, setStatus] = useState(live && live.key ? "connecting" : "off");
  const liveRef = useRef(live);
  const changeRef = useRef(onChange);
  const optionsRef = useRef({ safetyNetMs, fallbackMs });
  const follower = useRef(null);

  useEffect(() => {
    changeRef.current = onChange;
    optionsRef.current = { safetyNetMs, fallbackMs };
  });

  useEffect(() => {
    follower.current = createFollower({
      getLive: () => liveRef.current,
      reload: () => changeRef.current(),
      options: () => optionsRef.current,
      setStatus,
    });

    return () => {
      follower.current.stop();
      follower.current = null;
    };
  }, []);

  const key = live && live.key ? live.key : null;
  const expiresAt = live && live.expiresAt ? live.expiresAt : null;

  useEffect(() => {
    liveRef.current = key ? { key, expiresAt } : null;

    if (follower.current) {
      follower.current.update(liveRef.current);
    }
  }, [key, expiresAt]);

  return status;
}
