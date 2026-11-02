import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
// The platform's shared look loads first (@bmp/ui: the tokens and element
// styles, then the shared components built on them), then the staff app's own
// part of it (the frame, menus, tables, tiles…: styles/app), so each page's
// own stylesheet (imported by the page, inside App) comes after both and wins
// where they disagree.
import "@bmp/ui/styles.css";
import "./styles/app/index.css";
import AuthProvider from "./context/AuthProvider";
import ApprovalDialog from "./components/ApprovalDialog";
import ConfirmHost from "./components/ConfirmHost";
import Toaster from "./components/Toaster";
import { installFormValidation } from "./services/formValidation";
// The browser's offer to install the app, kept from the start (services/install.js).
import "./services/install";
import { registerServiceWorker } from "./services/offline/serviceWorker";
import UpdateBar from "./components/UpdateBar";
import App from "./App";
// One shared memory for answers screens read again and again (the dashboard,
// the settings): see services/queryClient.js.
import { queryClient } from "./services/queryClient";

// Every form's required/email/min checks show as a message under the field
// instead of the browser's bubble (services/formValidation.js).
installFormValidation();

// The service worker: production builds only (services/offline/serviceWorker.js).
registerServiceWorker();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          {/* The manager-PIN prompt, opened by any screen whose action needs
              an approval the signed-in person cannot give themselves. */}
          <ApprovalDialog />
          {/* "Are you sure?" from useConfirm(), and the toasts from services/toast.js. */}
          <ConfirmHost />
          <Toaster />
          {/* "A new version is ready": reloads only when pressed. */}
          <UpdateBar />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
