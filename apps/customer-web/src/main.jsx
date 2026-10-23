import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
// The platform's shared look first (tokens, element styles and the shared
// component sheets, in the staff app's order), so each page's own stylesheet
// comes after it and wins where the two disagree.
import "@bmp/ui/styles.css";
import App from "./App";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
