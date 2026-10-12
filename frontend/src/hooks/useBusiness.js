import { useContext } from "react";
import { BusinessContext } from "../context/business-context";

// The business the person is working in: the directory behind the switcher,
// the open business's context (modules, permissions, settings) and helpers.
export default function useBusiness() {
  const context = useContext(BusinessContext);

  if (!context) {
    throw new Error("useBusiness must be used inside <BusinessProvider>");
  }

  return context;
}
