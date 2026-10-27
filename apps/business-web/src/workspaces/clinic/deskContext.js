import { createContext, useContext } from "react";

// The clinic workspace's desk (useClinicDesk), read once by its layout and
// shared by its screens: the day's queue, whose queue is the signed-in
// doctor's, the server's clock and what this person may do.
export const DeskContext = createContext(null);

export const useDesk = () => {
  const desk = useContext(DeskContext);

  if (!desk) {
    throw new Error("useDesk must be used inside the clinic workspace's layout");
  }

  return desk;
};
