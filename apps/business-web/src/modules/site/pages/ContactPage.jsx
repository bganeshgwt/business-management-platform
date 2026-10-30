import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import SiteLayout from "../SiteLayout";
import CallBackForm from "../CallBackForm";
import { useSiteInfo, useSitePricing } from "../useSite";
import { websiteHref } from "../siteWords.js";

// Contact (/contact): the platform company's details, its support contact
// and grievance officer, and the form to ask to be called back. Only what the
// super admin has entered is shown.

function Detail({ icon, label, children }) {
  return (
    <li className="site-detail">
      <span className="site-detail-icon" aria-hidden="true">
        <Icon name={icon} size={17} />
      </span>
      <span>
        <small>{label}</small>
        {children}
      </span>
    </li>
  );
}

const mailto = (email) => <a href={`mailto:${email}`}>{email}</a>;
const tel = (phone) => <a href={`tel:${String(phone).replace(/[^\d+]/g, "")}`}>{phone}</a>;

export default function ContactPage() {
  const { data: info, error } = useSiteInfo();
  const { data: pricing } = useSitePricing();
  const company = info?.company || {};
  const support = info?.support || {};
  const grievance = info?.grievance || {};
  const place = [company.address, [company.city, company.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const anything = place || company.phone || company.email || company.website || support.phone || support.email || grievance.name || grievance.email;

  return (
    <SiteLayout title="Contact us" description="Reach the platform's team, its support and its grievance officer, or ask us to call you back.">
      <div className="site-wrap site-page">
        <header className="site-page-head">
          <h1>Contact us</h1>
          <p className="site-lede">Questions about the platform, a plan or a payment: reach us below, or ask us to call you back.</p>
        </header>
        <div className="site-contact">
          <section className="card stack" aria-labelledby="company-heading">
            <h2 id="company-heading">{company.name || "The platform company"}</h2>
            {error ? (
              <ErrorMessage message={getErrorMessage(error)} />
            ) : !info ? (
              <Loading />
            ) : !anything ? (
              <p className="muted">Our contact details are not published yet: ask us to call you back.</p>
            ) : (
              <ul className="site-details">
                {place && <Detail icon="map-pin" label="Address">{place}</Detail>}
                {company.phone && <Detail icon="phone" label="Phone">{tel(company.phone)}</Detail>}
                {company.email && <Detail icon="mail" label="Email">{mailto(company.email)}</Detail>}
                {company.website && (
                  <Detail icon="external" label="Website">
                    {websiteHref(company.website) ? <a href={websiteHref(company.website)} rel="noopener noreferrer">{company.website}</a> : company.website}
                  </Detail>
                )}
                {(support.phone || support.email) && (
                  <Detail icon="help" label="Support">
                    {support.phone && tel(support.phone)}
                    {support.phone && support.email && " · "}
                    {support.email && mailto(support.email)}
                  </Detail>
                )}
                {(grievance.name || grievance.email) && (
                  <Detail icon="shield" label="Grievance officer">
                    {grievance.name}
                    {grievance.name && grievance.email && " · "}
                    {grievance.email && mailto(grievance.email)}
                  </Detail>
                )}
              </ul>
            )}
          </section>
          <section className="card stack" aria-labelledby="contact-call-back">
            <h2 id="contact-call-back">Request a call back</h2>
            <CallBackForm info={info} types={pricing?.types || []} />
          </section>
        </div>
      </div>
    </SiteLayout>
  );
}
