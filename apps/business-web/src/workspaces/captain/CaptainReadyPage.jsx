import { EmptyState, ErrorMessage, Loading } from "../../components/Feedback";
import { countsOf, waitingList } from "./captainFloor.js";
import { useFloor } from "./floorContext";
import { useServe, useServerNow } from "./captainActions";
import MineSwitch from "./MineSwitch";
import ReadyTicket from "./ReadyTicket";

// Food the kitchen has marked ready for the captain's tables, the oldest at
// the pass first, each ticket served with one tap (the kitchen display's own
// Served: the ticket leaves the pass and its dishes are served on the order),
// and the dishes it ticked done on a ticket still cooking, each served on its
// own.
export default function CaptainReadyPage() {
  const floor = useFloor();
  const serverNow = useServerNow(floor.offset, 1000);
  const serving = useServe(floor);

  if (!floor.can.pass) {
    return (
      <section className="cpt-page" aria-labelledby="cpt-title">
        <div className="cpt-page-head">
          <h1 id="cpt-title">Ready to serve</h1>
        </div>
        <EmptyState
          icon="cloche"
          message="Food is marked ready on the kitchen display"
          hint="The kitchen display is switched off here, or your role does not handle KOTs."
        />
      </section>
    );
  }

  const tickets = waitingList(floor.shown, floor.waiting, "ready");
  const elsewhere = countsOf(floor.tables || [], floor.waiting).ready - tickets.length;

  return (
    <section className="cpt-page" aria-labelledby="cpt-title">
      <div className="cpt-page-head">
        <h1 id="cpt-title">Ready to serve</h1>
        <MineSwitch />
      </div>

      <ErrorMessage message={floor.errors.pass} />

      {!floor.loaded ? (
        <Loading label="Reading the pass…" />
      ) : tickets.length === 0 ? (
        <EmptyState
          icon="cloche"
          message="Nothing is waiting at the pass"
          hint="Food the kitchen marks ready for your tables lands here, the oldest first, with a buzz and a chime when alerts are on."
        />
      ) : (
        <div className="stack cpt-part">
          {tickets.map(({ entry }) => (
            <ReadyTicket
              key={entry.id}
              ticket={entry}
              now={serverNow}
              passMinutes={floor.pass.passMinutes}
              canServe={floor.can.serve}
              busy={serving.busy}
              error={serving.errors[entry.id]}
              onServe={serving.serve}
              onServeDish={serving.serveDish}
            />
          ))}
        </div>
      )}

      {floor.onlyMine && elsewhere > 0 && (
        <p className="muted small cpt-elsewhere">
          {elsewhere === 1 ? "One more ticket waits" : `${elsewhere} more tickets wait`} for other tables.{" "}
          <button type="button" className="link-button" onClick={() => floor.chooseMine(false)}>
            Show all tables
          </button>
        </p>
      )}
    </section>
  );
}
