import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <div className="page-center">
      <h1>Page not found</h1>
      <Link to="/">Go to dashboard</Link>
    </div>
  );
}
