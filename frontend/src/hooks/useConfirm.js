import { confirmAction } from "../services/confirm";

// const confirm = useConfirm();
// if (await confirm({ title: "Delete this item?", message: "…", confirmLabel: "Delete" })) { … }
// See services/confirm.js for the options.
export default function useConfirm() {
  return confirmAction;
}
