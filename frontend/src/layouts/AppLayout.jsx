import { NavLink, Outlet } from "react-router-dom";
import useAuth from "../hooks/useAuth";

export default function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Restaurant Management</span>
          {user.restaurantName && <span className="brand-restaurant">{user.restaurantName}</span>}
        </div>

        <nav className="nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
        </nav>

        <div className="user-menu">
          <span className="user-name">
            {user.name}
            <small>{user.roles.join(", ")}</small>
          </span>
          <button type="button" className="button button-secondary" onClick={logout}>
            Logout
          </button>
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
