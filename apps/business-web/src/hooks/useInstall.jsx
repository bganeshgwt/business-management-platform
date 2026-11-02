import { useEffect, useState } from "react";
import InstallSteps from "../components/InstallApp";
import { INSTALLABLE_APPS } from "../services/appManifest";
import { installState, promptInstall, subscribeInstall } from "../services/install";
import { toast } from "../services/toast";

// "Install the captain app" where it helps (the captain's ⋯ menu, the
// counter's More menu, the clinic's and the lab's menus): the browser's own
// install where it offers one, the steps on an iPhone or iPad (Share, then
// Add to Home Screen), nothing once the app runs installed.
//
//   const install = useInstall("captain");
//   items: [install.item, ...]   and render {install.dialog}
export default function useInstall(app) {
  const [state, setState] = useState(installState);
  const [steps, setSteps] = useState(false);
  const { name, install: label } = INSTALLABLE_APPS[app] || INSTALLABLE_APPS.staff;

  useEffect(() => subscribeInstall(setState), []);

  const install = async () => {
    if (state.offer === "ios") {
      setSteps(true);
      return;
    }

    const outcome = await promptInstall();

    if (outcome === "accepted") {
      toast.success(`${name} is installed: open it from your home screen or app list.`);
    }
  };

  return {
    offer: state.offer,
    item: state.offer ? { label, icon: "download", onClick: install } : null,
    dialog: steps ? <InstallSteps name={name} onClose={() => setSteps(false)} /> : null,
  };
}
