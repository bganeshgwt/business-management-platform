import { createContext, useContext } from "react";

// The salesperson app's day, read once by its layout (useSalesDay.js) and
// shared by its screens.
export const SalesContext = createContext(null);

export const useSales = () => useContext(SalesContext);
