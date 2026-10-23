import { createContext } from "react";

// Kept in its own file so BusinessProvider.jsx only exports a component,
// which React Fast Refresh (hot reload) requires.
export const BusinessContext = createContext(null);
