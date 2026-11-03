import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { consoleBusinessTypes } from "../services/console.service";
import "../styles/console.css";
import "../../../styles/words.css";

// Platform › Business types (/platform/business-types): every type a business
// can be, with its mark and accent, its kinds (a yoga studio among gyms,
// studios and coaching) and how many businesses use it. A type's page sets its
// look, its kinds and the words its businesses see on every screen, bill and
// message.
export default function PlatformBusinessTypesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    consoleBusinessTypes().then(setData).catch((err) => setError(getErrorMessage(err)));
  }, []);
  return (
    <div className="stack pc-page">
      <PageHeader icon="grid" eyebrow="Platform" title="Business types"
        description="What each kind of business is called, its mark and colour, its kinds, and the words its screens use: members and trainers for a gym, patients and doctors for a clinic, udhaar for a kirana." />
      <ErrorMessage message={error} />
      {!data && !error && <Loading />}
      {data && (
        <ul className="bt-grid">
          {data.types.map((type) => (
            <li key={type.code}>
              <Link className="bt-card" to={`/platform/business-types/${type.code}`}>
                <span className={`bt-mark type-accent-${type.accent}`} aria-hidden="true"><Icon name={type.icon} fallback="store" size={22} /></span>
                <span className="bt-card-text">
                  <strong>{type.name}</strong>
                  <small className="muted">
                    {type.businesses === 1 ? "1 business" : `${type.businesses} businesses`}
                    {" · "}{type.words === 1 ? "1 word of its own" : `${type.words} words of its own`}
                    {" · "}a new item starts as {type.defaultItemKind === "service" ? "a service" : "goods"}
                  </small>
                  {type.kinds.length > 0 && (
                    <span className="bt-kinds">
                      {type.kinds.map((kind) => (
                        <span key={kind.code} className={`bt-kind${kind.active ? "" : " is-off"}`}>
                          <Icon name={kind.icon || type.icon} fallback="store" size={13} /> {kind.name}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <Icon name="chevron-right" size={18} className="bt-go" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
