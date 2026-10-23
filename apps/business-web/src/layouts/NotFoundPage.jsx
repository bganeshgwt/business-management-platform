import { Link } from "react-router-dom";
import Icon, { BrandMark } from "@bmp/ui/Icon";

// A link that goes nowhere — an old bookmark, a typo in the address. Said
// plainly, with the one way out most people want.
export default function NotFoundPage() {
  return (
    <div className="page-center not-found">
      <BrandMark size={44} />
      <p className="not-found-code">404</p>
      <h1>Page not found</h1>
      <p className="muted">The address may be old or mistyped. Nothing has been changed.</p>
      <Link to="/" className="button">
        <Icon name="home" size={17} />
        Go to dashboard
      </Link>
    </div>
  );
}
