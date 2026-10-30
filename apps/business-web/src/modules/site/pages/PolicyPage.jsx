import { Fragment } from "react";
import { Link } from "react-router-dom";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import SiteLayout from "../SiteLayout";
import { useSiteInfo } from "../useSite";
import { POLICY_TITLES, policyOf } from "../sitePolicies.js";

// The platform's policies, one address each: its terms of service (/terms),
// its privacy policy (/privacy-policy; /privacy is a restaurant's own Personal
// data screen) and its refunds, cancellation and service delivery
// (/refunds). Each says what the platform really does, with the company's
// details, the trial, the grace days and the GST rate from the site's info
// (sitePolicies.js).

const OTHERS = [
  { kind: "terms", to: "/terms" },
  { kind: "privacy", to: "/privacy-policy" },
  { kind: "refunds", to: "/refunds" },
];

const DESCRIPTIONS = {
  terms: "The terms on which a business uses the platform: the free trial, paying for a plan, what happens when a plan ends, and its records.",
  privacy: "What the platform collects about the people who ask to be called back, sign up or sign in, why, and the rights they have.",
  refunds: "How a plan is paid for, stopped and delivered, and why a paid period is not refunded.",
};

export default function PolicyPage({ kind }) {
  const { data: info, error } = useSiteInfo();
  const policy = info ? policyOf(kind, info) : null;

  return (
    <SiteLayout title={POLICY_TITLES[kind]} description={policy ? policy.description : DESCRIPTIONS[kind]}>
      <article className="site-wrap site-page site-policy">
        <h1>{POLICY_TITLES[kind]}</h1>
        {error ? (
          <ErrorMessage message={getErrorMessage(error)} />
        ) : !policy ? (
          <Loading />
        ) : (
          <>
            <p className="site-lede">{policy.lead}</p>
            {policy.sections.map((section) => (
              <section key={section.heading}>
                <h2>{section.heading}</h2>
                {section.body.map((part, index) => (
                  <Fragment key={index}>
                    {typeof part === "string" ? (
                      <p>{part}</p>
                    ) : (
                      <ul>
                        {part.list.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </Fragment>
                ))}
              </section>
            ))}
          </>
        )}
        <nav className="site-policy-others" aria-label="Other policies">
          {OTHERS.filter((other) => other.kind !== kind).map((other) => (
            <Link key={other.kind} to={other.to}>{POLICY_TITLES[other.kind]}</Link>
          ))}
          <Link to="/contact">Contact us</Link>
        </nav>
      </article>
    </SiteLayout>
  );
}
