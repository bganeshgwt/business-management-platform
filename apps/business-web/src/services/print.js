// How the app prints anything: a receipt, a table's QR card.
//
// Two earlier attempts both printed a blank sheet, for different reasons:
//
//   window.open("") + document.write — the new window races its own
//   about:blank load, so the write can land on a document the browser is about
//   to replace. It is also the first thing a popup blocker stops.
//
//   a hidden iframe + srcdoc — appending the frame starts an about:blank load
//   of its own, and a frame styled to zero width and height gives the printer
//   no layout to work from. What came out was one empty page carrying the
//   parent page's title and URL, which read as "the bill is blank".
//
// So nothing is printed out-of-document any more. The receipt goes into THIS
// page, inside a container that exists only while printing, and a print
// stylesheet hides everything else. The browser lays out and prints the
// document it is already showing — the one case with no race, no popup
// blocker, and nothing to wait for.

// Text typed by the restaurant — a dish name, a bill footer — is escaped, so a
// name like "Fish & Chips" cannot break the markup and one containing a tag
// cannot inject anything into the page being printed.
export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// The id the print stylesheet keys off.
const PRINT_ROOT_ID = "print-root";

// Set on <html> for as long as the receipt is on the page, so the stylesheet
// hides the app only while something is actually being printed.
const PRINTING_CLASS = "is-printing";

// A receipt carries its own typeface and width, which must not leak into the
// app once the container is gone. Scoping every rule under the container's id
// keeps it contained without needing Shadow DOM.
const scopeStyles = (styles) =>
  String(styles || "")
    .split("}")
    .map((block) => {
      const [selectors, body] = block.split("{");

      if (!body) {
        return "";
      }

      // An at-rule such as @page applies to the sheet, not to an element, and
      // must not be given a parent selector.
      if (selectors.trim().startsWith("@")) {
        return `${selectors.trim()} { ${body.trim()} }`;
      }

      const scoped = selectors
        .split(",")
        .map((one) => {
          const name = one.trim();

          if (!name) {
            return "";
          }

          // "body { … }" inside a receipt means the receipt itself.
          return name === "body" || name === "html"
            ? `html.${PRINTING_CLASS} #${PRINT_ROOT_ID}`
            : `#${PRINT_ROOT_ID} ${name}`;
        })
        .filter(Boolean)
        .join(", ");

      return scoped ? `${scoped} { ${body.trim()} }` : "";
    })
    .filter(Boolean)
    .join("\n");

export const printDocument = ({ title, styles = "", body }) => {
  // Anything left over from a print the user cancelled.
  const stale = document.getElementById(PRINT_ROOT_ID);
  const staleStyles = document.getElementById(`${PRINT_ROOT_ID}-styles`);

  if (stale) {
    stale.remove();
  }

  if (staleStyles) {
    staleStyles.remove();
  }

  const sheet = document.createElement("style");
  sheet.id = `${PRINT_ROOT_ID}-styles`;
  // @page belongs to the sheet rather than to any element, so it is written
  // out whole rather than scoped.
  sheet.textContent = `@page { margin: 6mm; }
${scopeStyles(styles)}`;

  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = body;

  document.head.appendChild(sheet);
  document.body.appendChild(root);
  document.documentElement.classList.add(PRINTING_CLASS);

  // The tab title becomes the default filename when printing to PDF, so a bill
  // saved from the dialog is named after the bill rather than after the app.
  const previousTitle = document.title;

  if (title) {
    document.title = String(title);
  }

  let cleaned = false;

  const clean = () => {
    if (cleaned) {
      return;
    }

    cleaned = true;
    document.documentElement.classList.remove(PRINTING_CLASS);
    document.title = previousTitle;
    root.remove();
    sheet.remove();
  };

  // afterprint fires whether the job was sent or the dialog cancelled. The
  // timer is a backstop for anything that never fires it.
  window.addEventListener("afterprint", clean, { once: true });
  setTimeout(clean, 60000);

  // The markup is laid out by the time this runs, because appendChild is
  // synchronous — but a QR card carries an image, and printing before it has
  // decoded puts a gap on the paper where the code should be. A receipt has no
  // images and goes straight through.
  const images = Array.from(root.querySelectorAll("img"));
  const pending = images.filter((image) => !image.complete);

  if (pending.length === 0) {
    window.print();

    return;
  }

  let fired = false;

  const go = () => {
    if (fired) {
      return;
    }

    fired = true;
    window.print();
  };

  let waiting = pending.length;

  const oneDone = () => {
    waiting -= 1;

    if (waiting === 0) {
      go();
    }
  };

  for (const image of pending) {
    // Either outcome prints: a card with a broken image beats a button that
    // silently does nothing.
    image.addEventListener("load", oneDone, { once: true });
    image.addEventListener("error", oneDone, { once: true });
  }

  // And a backstop, for an image that neither loads nor errors.
  setTimeout(go, 2000);
};
