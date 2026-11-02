import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import GuestShell from "../shared/GuestShell";
import { GuestError, GuestSkeleton } from "../shared/GuestStates";
import { guestErrorMessage, publicClient } from "../shared/publicClient";
import "../modules/privacy/privacy.css";

// A business's privacy notice, from the link at the foot of its guest pages
// and beside their consent boxes: /privacy-notice/<reference> (GET
// /api/public/privacy/:ref). The notice in force, what each consent a page
// may ask says, and whom to ask about your data. Opened in a tab of its own,
// so a booking or an order half filled in stays as it was.

const api = publicClient("/privacy");

const dateLabel = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null;
};

export default function PrivacyPage() {
  const { ref } = useParams();
  const [answer, setAnswer] = useState(null);
  const [problem, setProblem] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;

    api
      .get(`/${encodeURIComponent(ref)}`)
      .then((response) => {
        if (!alive) return;
        setAnswer(response.data.data);
        setProblem(null);
      })
      .catch((error) => {
        if (alive) setProblem(error);
      });

    return () => {
      alive = false;
    };
  }, [ref, attempt]);

  useEffect(() => {
    if (answer) {
      document.title = `Privacy notice · ${answer.business.name}`;
    }
  }, [answer]);

  if (problem && !answer) {
    const gone = problem.response && problem.response.status === 404;

    return (
      <main className="guest-app guest-center">
        <GuestError
          heading="h1"
          icon="shield"
          title={gone ? "This privacy notice is not available" : "Something went wrong"}
          message={guestErrorMessage(problem)}
          onRetry={gone ? null : () => setAttempt((n) => n + 1)}
        />
      </main>
    );
  }

  const card = answer ? { name: answer.business.name, logoUrl: answer.business.logoUrl, location: {}, hours: null, seller: {}, privacy: null } : null;
  const notice = answer && answer.notice;
  const since = notice && dateLabel(notice.publishedAt);
  const asks = notice ? [notice.billsText, notice.remindersText, notice.offersText].filter(Boolean) : [];

  return (
    <GuestShell card={card} context="Privacy notice">
      {!notice ? (
        <GuestSkeleton cards={2} lines={5} label="Opening the privacy notice" />
      ) : (
        <article className="gp-page">
          <header className="gp-page-head">
            <span className="gp-page-mark" aria-hidden="true">
              <Icon name="shield" size={22} />
            </span>
            <div>
              <h1>Privacy notice</h1>
              <p className="gp-page-meta">
                Version {notice.version}
                {since ? ` · in force since ${since}` : ""}
              </p>
            </div>
          </header>
          <pre className="gp-notice gp-notice-page">{notice.text}</pre>
          {asks.length > 0 && (
            <section className="gp-asks" aria-labelledby="gp-asks-title">
              <h2 id="gp-asks-title">What you may agree to</h2>
              <p>Each is a choice of its own, never ticked for you, and you can change your mind at any time.</p>
              <ul>
                {asks.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </section>
          )}
          {notice.contact && (
            <p className="gp-contact">
              <Icon name="mail" size={16} />
              <span>
                Questions about your data, or to see, correct or erase it: <strong>{notice.contact}</strong>
              </span>
            </p>
          )}
        </article>
      )}
    </GuestShell>
  );
}
