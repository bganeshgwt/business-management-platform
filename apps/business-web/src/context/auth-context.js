import { createContext } from "react";

// Kept in its own file so AuthProvider.jsx only exports a component,
// which React Fast Refresh (hot reload) requires.
export const AuthContext = createContext(null);
