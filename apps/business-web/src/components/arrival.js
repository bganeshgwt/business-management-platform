// When has a screen finished loading?
//
// Some screens show 0 in a figure while their data loads (an empty list
// counts 0) and then the real figure. To <LiveValue> that looks exactly like
// a live change — "0" sliding out, "42" sliding in with a glow — which would
// tell the owner something had just changed when the screen was only
// loading. So a 0 is provisional until its screen has finished loading: the
// requests that were running when the figure appeared, and any they led to,
// have all been answered, and the app has then been quiet for a moment. A
// change from 0 before that is the data arriving and is shown at once
// (hooks/useLiveChange.js); after it, and between any two real figures,
// every change is a real one, and moves.
//
// Only when the app's requests start and finish is watched (through the
// shared API client's interceptors) — never what they carry or where they go.
import api from "../services/api";
import { CAPTURE_HEADER } from "../services/approval";

// The app has to be quiet this long for a screen to count as loaded.
const REST_MS = 300;
// After this long a figure counts as settled whatever the network does, so a
// screen that is never quiet still shows its live changes.
const LONGEST_MS = 10000;
// A request still unanswered after this long is no longer waited for.
const FORGET_MS = 20000;
// How many quiet stretches are remembered.
const KEEP_RESTS = 16;

const running = new Map(); // request number → when it started
const rests = []; // [from, to]: stretches when no request was running
let quietSince = 0; // when the last running request finished
let lastNumber = 0;

const clock = () => (typeof performance === "undefined" ? Date.now() : performance.now());

// A request that never answered (a tab put to sleep, a dropped connection)
// must not keep the app "loading" for ever.
const forgetStuck = (now) => {
  for (const [number, startedAt] of running) {
    if (now - startedAt > FORGET_MS) {
      running.delete(number);

      if (running.size === 0) {
        quietSince = startedAt + FORGET_MS;
      }
    }
  }
};

const isCapture = (config) => {
  const headers = config.headers || {};
  return typeof headers.has === "function" ? headers.has(CAPTURE_HEADER) : Boolean(headers[CAPTURE_HEADER]);
};

const started = (config) => {
  // A request only asked about for a manager's approval is never sent.
  if (isCapture(config)) {
    return config;
  }

  const now = clock();
  forgetStuck(now);

  if (running.size === 0) {
    rests.push([quietSince, now]);

    if (rests.length > KEEP_RESTS) {
      rests.shift();
    }
  }

  // A retry (a renewed sign-in, a manager's approval) replaces its first try.
  running.delete(config.motionRequest);
  lastNumber += 1;
  running.set(lastNumber, now);
  config.motionRequest = lastNumber;
  return config;
};

const finished = (config) => {
  if (config && running.delete(config.motionRequest) && running.size === 0) {
    quietSince = clock();
  }
};

api.interceptors.request.use(started);
api.interceptors.response.use(
  (response) => {
    finished(response?.config);
    return response;
  },
  (error) => {
    finished(error?.config);
    return Promise.reject(error);
  },
);

// True once the app has been quiet for REST_MS at some point after `since`
// (a performance.now() time) — whatever was loading then has arrived — or
// once LONGEST_MS have passed since then.
export const settledSince = (since) => {
  const now = clock();

  if (now - since >= LONGEST_MS) {
    return true;
  }

  forgetStuck(now);
  const stretches = running.size === 0 ? [...rests, [quietSince, now]] : rests;
  return stretches.some(([from, to]) => to - Math.max(from, since) >= REST_MS);
};

export const now = clock;
