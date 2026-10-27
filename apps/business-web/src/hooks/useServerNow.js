import { useEffect, useState } from "react";

// The time on the server's clock, moving every `every` ms: the waiting clocks
// of the captain app, the clinic's queue and the lab's bench. `offset` is the
// server's clock less this device's (from a reply's server time), so a device
// a few minutes off does not make anyone look more or less patient.
export default function useServerNow(offset, every = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), every);

    return () => clearInterval(tick);
  }, [every]);

  return now + offset;
}
