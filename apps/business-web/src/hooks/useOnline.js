import { useSyncExternalStore } from "react";
import { onlineState, subscribeOnline } from "../services/offline/online";

// Whether this device reaches the server now: { online, since }. The
// browser's network flag and the API's own answers together
// (services/offline/online.js).
const subscribe = (onChange) => subscribeOnline(() => onChange());

export default function useOnline() {
  return useSyncExternalStore(subscribe, onlineState, onlineState);
}
