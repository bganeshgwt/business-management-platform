import Icon from "@bmp/ui/Icon";
import LiveDot from "./LiveDot";
import "./shared.css";

// A guest's way through what they asked for, as a timeline: each step done
// ticked, the one being waited for marked, and when each happened when the
// page knows it. Up to five steps sit in a row (a phone at 360 px included);
// more go one under another.
//
//   <StatusSteps steps={[{ key: "sent", label: "Sent", at: "7:42 pm" }, …]}
//                current="accepted" live={liveStatus} />
//
//   steps    [{ key, label, at? }]; `at` is a time already written for people
//   current  the key of the step reached (null: none yet)
//   stopped  it will go no further (declined, cancelled): nothing is "next"
//   live     useGuestLive's status, shown as the LiveDot under the steps
export default function StatusSteps({ steps, current, stopped = false, live = null, label = "Progress" }) {
  const reached = steps.findIndex((step) => step.key === current);
  const row = steps.length <= 5;

  return (
    <div className={`gs-steps-box ${stopped ? "is-stopped" : ""}`}>
      <ol className={`gs-steps ${row ? "is-row" : "is-column"} ${steps.length === 5 ? "is-tight" : ""}`} aria-label={label} style={{ "--gs-steps": steps.length }}>
        {steps.map((step, index) => {
          const done = index <= reached;
          const next = !stopped && index === reached + 1;

          return (
            <li key={step.key} className={done ? "is-done" : next ? "is-next" : ""} aria-current={index === reached ? "step" : undefined}>
              <span className="gs-step-dot" aria-hidden="true">
                {done ? <Icon name="check" size={12} /> : null}
              </span>
              <span className="gs-step-text">
                <span className="gs-step-label">{step.label}</span>
                {step.at && <span className="gs-step-time">{step.at}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {live && <LiveDot status={live} className="gs-steps-live" />}
    </div>
  );
}
