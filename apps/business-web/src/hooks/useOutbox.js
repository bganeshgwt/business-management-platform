import { useEffect, useState } from "react";
import { outbox } from "../services/offline/outboxStore";

// The outbox as the indicators show it: { items, counts: { waiting, sending,
// attention, total }, paused, durable } (services/offline/outbox.js).
export default function useOutbox() {
  const [state, setState] = useState(() => outbox.snapshot());

  useEffect(() => outbox.subscribe(setState), []);

  return state;
}
