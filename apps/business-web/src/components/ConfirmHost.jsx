import { useEffect, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { settleConfirm, subscribeConfirm } from "../services/confirm";

// Draws the question asked through useConfirm() / confirmAction(). Mounted
// once, in main.jsx.
export default function ConfirmHost() {
  const [question, setQuestion] = useState(null);

  useEffect(() => subscribeConfirm(setQuestion), []);

  // Leaving the page answers "no", so a promise never hangs.
  useEffect(() => () => settleConfirm(false), []);

  if (!question) {
    return null;
  }

  return (
    <ConfirmDialog
      title={question.title}
      message={question.message}
      confirmLabel={question.confirmLabel}
      cancelLabel={question.cancelLabel}
      tone={question.tone}
      onConfirm={() => settleConfirm(true)}
      onCancel={() => settleConfirm(false)}
    />
  );
}
