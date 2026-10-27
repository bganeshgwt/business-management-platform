import { createContext, useContext } from "react";

// The captain app's floor (useCaptainFloor), read once by its layout and
// shared by its screens: the tables, what is waiting at each one, the live
// stream's status and the alerts switch.
export const FloorContext = createContext(null);

export const useFloor = () => {
  const floor = useContext(FloorContext);

  if (!floor) {
    throw new Error("useFloor must be used inside the captain app's layout");
  }

  return floor;
};
