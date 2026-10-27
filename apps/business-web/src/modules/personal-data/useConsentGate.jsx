import { useCallback, useState, useSyncExternalStore } from "react";
import AskConsentDialog from "./components/AskConsentDialog";
import { consentStore } from "./consentStore";
import { consentAllows } from "./personalData";

// Every button that sends or opens a message to a customer asks first
// whether they agreed to its purpose: bills on WhatsApp or SMS, reminders,
// offers. With their consent it goes straight away; without it, the button
// asks the person and records their yes in one tap, on the notice's own line
// for that purpose, then sends. A message about what they asked for (their
// order is ready, their booking is confirmed) needs no consent and is not gated.
//
//   const gate = useConsentGate(privacy);              // privacy: useShopPrivacy() / useRestaurantPrivacy()
//   if (await gate.ensure("reminders", { id, name })) { window.open(link); record(); }
//   …{gate.dialog}
//
// A link alone: components/ConsentLink.jsx.
export function useConsentGate(privacy) {
  const store = consentStore(privacy.api);
  useSyncExternalStore(store.subscribe, store.version);
  const [asking, setAsking] = useState(null);

  // Resolves true when the person agreed to the purpose (asking them first if needed).
  const ensure = useCallback(async (purpose, person, { sending = true } = {}) => {
    let status = store.status(person?.id);
    if (person?.id && status === undefined) {
      try {
        const result = await privacy.api.lookup([person.id]);
        store.setNotice(result.notice || null);
        status = result.people?.[person.id] || { purposes: [], child: false, erased: false };
        store.setStatus(person.id, status);
      } catch {
        status = null;
      }
    }
    if (consentAllows(status, purpose)) return true;
    return new Promise((resolve) => setAsking({ purpose, person, sending, resolve }));
  }, [privacy.api, store]);

  const want = useCallback((id) => store.want(id), [store]);
  // true / false once known; undefined while it loads.
  const allowed = (purpose, id) => {
    const status = store.status(id);
    return status === undefined ? undefined : consentAllows(status, purpose);
  };

  const finish = (answer) => {
    asking?.resolve(answer);
    setAsking(null);
  };
  const dialog = asking && (
    <AskConsentDialog privacy={privacy} purpose={asking.purpose} person={asking.person} status={store.status(asking.person?.id)} notice={store.notice()}
      sending={asking.sending} onClose={() => finish(false)} onAgreed={() => finish(true)} />
  );
  return { ensure, allowed, want, dialog };
}
