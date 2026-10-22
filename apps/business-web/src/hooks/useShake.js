import { useCallback, useRef } from "react";
import { shake as shakeNode } from "../components/motion";

// A gentle shake for refused input — a wrong PIN, a refused sign-in.
//
//   const [pinRef, shake] = useShake();
//   <div ref={pinRef}>…</div>
//   …in the failure handler:  shake();
//
// Call it from the event that failed (or an effect keyed on a refusal
// counter), never on every render. It replays each time it is called, does
// nothing with reduced motion, and moves only `transform`, so nothing around
// it shifts. Pair it with the words of the error: the shake is a hint, the
// message is the meaning.
export default function useShake() {
  const ref = useRef(null);
  const shake = useCallback(() => shakeNode(ref.current), []);

  return [ref, shake];
}
