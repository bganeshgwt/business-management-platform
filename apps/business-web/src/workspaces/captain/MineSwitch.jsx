import { useFloor } from "./floorContext";

// "My tables" or "All tables", in the words the POS's tables use: shown to
// someone with a captain section today, and the same choice on every screen
// of the captain app (its tables, calls and food at the pass).
export default function MineSwitch() {
  const floor = useFloor();

  if (floor.mine.length === 0) {
    return null;
  }

  return (
    <div className="segmented cpt-mine" role="radiogroup" aria-label="Which tables">
      <button
        type="button"
        role="radio"
        aria-checked={floor.onlyMine}
        className={`segment ${floor.onlyMine ? "is-active" : ""}`}
        onClick={() => floor.chooseMine(true)}
      >
        My tables · {floor.mine.length}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!floor.onlyMine}
        className={`segment ${!floor.onlyMine ? "is-active" : ""}`}
        onClick={() => floor.chooseMine(false)}
      >
        All tables · {(floor.tables || []).length}
      </button>
    </div>
  );
}
