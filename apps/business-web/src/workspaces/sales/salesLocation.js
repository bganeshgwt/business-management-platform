// Where the phone is, for the salesperson app: read only when the app asks
// (the day's start and end, a check-in, a new shop), never in the background,
// and only between "Start my day" and "End my day" (the app's notice). A few
// seconds are given for a better fix (indoors a phone's first answer is
// often hundreds of metres out); the best answer within them is taken.
//
//   const place = await locate();   // { latitude, longitude, accuracy } or { problem }

const GOOD_ENOUGH_M = 25;

export function locate({ waitMs = 8000 } = {}) {
  const geo = typeof navigator === "undefined" ? null : navigator.geolocation;
  if (!geo) return Promise.resolve({ problem: "This phone cannot give its location." });
  return new Promise((resolve) => {
    let best = null;
    let watch = null;
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      if (watch !== null) geo.clearWatch(watch);
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(best || { problem: "The phone could not find its location in time. Step outside, or go on without it." }), waitMs);
    const take = (position) => {
      const fix = { latitude: Number(position.coords.latitude.toFixed(6)), longitude: Number(position.coords.longitude.toFixed(6)), accuracy: Math.round(position.coords.accuracy) };
      if (!best || fix.accuracy < best.accuracy) best = fix;
      if (best.accuracy <= GOOD_ENOUGH_M) finish(best);
    };
    const failed = (error) => {
      if (best) return;
      finish({ problem: error?.code === 1 ? "Location is not allowed for this app. Allow it in the browser's settings to record your check-ins." : "The phone could not find its location." });
    };
    try {
      watch = geo.watchPosition(take, failed, { enableHighAccuracy: true, maximumAge: 15000, timeout: waitMs });
    } catch {
      finish({ problem: "This phone cannot give its location." });
    }
  });
}
