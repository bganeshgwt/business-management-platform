import { toast } from "../services/toast";

// The app's toasts, for a component: const toast = useToast(); toast.success("Saved").
// Same object as services/toast.js (usable outside React too).
export default function useToast() {
  return toast;
}
