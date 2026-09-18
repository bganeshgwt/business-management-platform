import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthContext } from "./auth-context";
import { tokenStorage } from "../services/api";
import { getCurrentUser, loginRequest } from "../services/auth.service";

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(tokenStorage.get()));

  // On page load, turn a saved token back into a user (or drop it if it is no longer valid).
  useEffect(() => {
    if (!tokenStorage.get()) {
      return;
    }

    getCurrentUser()
      .then(setUser)
      .catch(() => tokenStorage.clear())
      .finally(() => setLoading(false));
  }, []);

  // api.js fires this when the server rejects the token.
  useEffect(() => {
    const handleLogout = () => setUser(null);
    window.addEventListener("auth:logout", handleLogout);
    return () => window.removeEventListener("auth:logout", handleLogout);
  }, []);

  const login = useCallback(async (email, password) => {
    const result = await loginRequest(email, password);
    tokenStorage.set(result.token);
    setUser(result.user);
  }, []);

  const logout = useCallback(() => {
    tokenStorage.clear();
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (permission) => Boolean(user?.permissions.includes(permission)),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, hasPermission }),
    [user, loading, login, logout, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
