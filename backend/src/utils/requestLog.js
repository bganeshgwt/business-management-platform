// What the request log (morgan, app.js) prints for an address.
//
// A guest page's live updates are opened with a key in the address
// (GET /api/public/live?key=…): the browser's EventSource sends no headers.
// The key names what one guest may watch for two hours, so the log never
// prints it: the value of every "key" in a query, however its name is
// written (KEY, %6Bey), is printed as "hidden", whatever the path. The rest
// of the address is printed as it came.
const nameOf = (part) => {
  const name = part.split("=", 1)[0].replace(/\+/g, " ");

  try {
    return decodeURIComponent(name).trim().toLowerCase();
  } catch {
    return name.trim().toLowerCase();
  }
};

const safeUrl = (url) => {
  const text = String(url || "");
  const query = text.indexOf("?");

  if (query < 0) {
    return text;
  }

  const hash = text.indexOf("#", query);
  const end = hash < 0 ? text.length : hash;
  const parts = text.slice(query + 1, end).split(/([&;])/);
  const shown = parts
    .map((part, index) => (index % 2 === 0 && part.includes("=") && nameOf(part) === "key" ? `${part.split("=", 1)[0]}=hidden` : part))
    .join("");

  return `${text.slice(0, query + 1)}${shown}${text.slice(end)}`;
};

module.exports = { safeUrl };
