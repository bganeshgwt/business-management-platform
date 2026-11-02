import Icon from "@bmp/ui/Icon";
import Modal from "./Modal";
import "../styles/offline.css";

// Safari has no install button of its own: the steps, with the Share mark
// drawn as Safari draws it.
export default function InstallSteps({ name, onClose, why }) {
  return (
    <Modal title={`Add ${name} to your Home Screen`} icon="download" onClose={onClose} width={460}
      footer={<button type="button" className="button" onClick={onClose}>Done</button>}>
      <div className="stack">
        {why && <p>{why}</p>}
        <ol className="install-steps">
          <li>
            <span>
              In Safari, tap <strong>Share</strong>
              <span className="install-share" aria-hidden="true"><Icon name="upload" size={14} /></span>
              at the bottom of the screen (at the top on an iPad).
            </span>
          </li>
          <li>
            <span>Scroll down and tap <strong>Add to Home Screen</strong>.</span>
          </li>
          <li>
            <span>Tap <strong>Add</strong>, then open {name} from its icon on your Home Screen.</span>
          </li>
        </ol>
        <p className="muted small">It opens full screen, like any app, and stays signed in.</p>
      </div>
    </Modal>
  );
}
