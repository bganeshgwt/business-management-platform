import useAuth from "../hooks/useAuth";

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="stack">
      <div>
        <h1>Welcome, {user.name}</h1>
        <p className="muted">
          {user.restaurantName ? `Signed in to ${user.restaurantName}` : "Signed in as a platform user"}
        </p>
      </div>

      <section className="card">
        <h2>Your account</h2>
        <dl className="details">
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Roles</dt>
          <dd>{user.roles.join(", ") || "None"}</dd>
          <dt>Restaurant ID</dt>
          <dd>{user.restaurantId ?? "Platform (all restaurants)"}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Your permissions ({user.permissions.length})</h2>
        <ul className="chips">
          {user.permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
