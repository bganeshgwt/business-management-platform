import { createContext, useContext } from "react";

// The lab workspace's bench (useLabBench), read once by its layout and shared
// by its screens: every open order and those reported today, what waits at
// each stage, the server's clock and what this person may do.
export const BenchContext = createContext(null);

export const useBench = () => {
  const bench = useContext(BenchContext);

  if (!bench) {
    throw new Error("useBench must be used inside the lab workspace's layout");
  }

  return bench;
};
