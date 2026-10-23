// Barcodes drawn as SVG for printed shelf and product labels.
//
// EAN-13 for 13-digit codes with a correct check digit (what packets, books
// and the shop's own "200…" codes carry), Code 128 for anything else (SKU
// codes like "RICE-SM"). Both are what every retail scanner reads. The SVG
// has no text: the label prints the code underneath in its own type.

// Code 128 bar/space widths for values 0–106 (106 = stop).
const C128 = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 " +
  "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 " +
  "232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 " +
  "313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 " +
  "111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
  "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 " +
  "114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112"
).split(" ");
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

// Values for the text: set C (digit pairs) where a long run of digits makes
// the barcode shorter, set B for everything else printable.
function code128Values(text) {
  const values = [];
  let set = null;
  let i = 0;
  const digitRun = (from) => {
    let n = 0;
    while (from + n < text.length && /\d/.test(text[from + n])) n += 1;
    return n;
  };
  while (i < text.length) {
    const run = digitRun(i);
    const useC = run >= 4 && (run % 2 === 0 || set === "C" || i + run === text.length || run >= 6);
    if (useC) {
      const pairs = Math.floor(run / 2);
      if (set !== "C") { values.push(set ? CODE_C : START_C); set = "C"; }
      for (let p = 0; p < pairs; p += 1) { values.push(Number(text.slice(i, i + 2))); i += 2; }
      if (run % 2 === 0) continue;
    }
    if (set !== "B") { values.push(set ? CODE_B : START_B); set = "B"; }
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) throw new Error("Only plain letters, digits and symbols can be printed as a barcode");
    values.push(code - 32);
    i += 1;
  }
  const check = values.reduce((sum, value, index) => sum + value * (index === 0 ? 1 : index), 0) % 103;
  return [...values, check, STOP];
}

// Module widths: bar, space, bar, … starting with a bar.
function code128Widths(text) {
  return code128Values(text).flatMap((value) => C128[value].split("").map(Number));
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = L.map((code) => code.split("").map((b) => (b === "1" ? "0" : "1")).join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function eanCheckDigit(twelve) {
  const total = twelve.split("").reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0);
  return String((10 - (total % 10)) % 10);
}
const isEan13 = (code) => /^\d{13}$/.test(code) && eanCheckDigit(code.slice(0, 12)) === code[12];

// "1" = bar module, "0" = space module.
function ean13Modules(code) {
  const digits = code.split("").map(Number);
  const parity = PARITY[digits[0]];
  let bits = "101";
  for (let i = 1; i <= 6; i += 1) bits += (parity[i - 1] === "L" ? L : G)[digits[i]];
  bits += "01010";
  for (let i = 7; i <= 12; i += 1) bits += R[digits[i]];
  return `${bits}101`;
}

// An SVG barcode for `code`, `height` units tall; width follows the code.
// Returns { svg, kind } or throws for text a barcode cannot carry.
export function barcodeSvg(code, { height = 40 } = {}) {
  const text = String(code || "").trim();
  if (!text) throw new Error("Nothing to print as a barcode");
  let rects = "";
  let x = 10; // quiet zone
  let kind;
  if (isEan13(text)) {
    kind = "EAN-13";
    for (const bit of ean13Modules(text)) {
      if (bit === "1") rects += `<rect x="${x}" y="0" width="1" height="${height}"/>`;
      x += 1;
    }
  } else {
    kind = "Code 128";
    code128Widths(text).forEach((width, index) => {
      if (index % 2 === 0) rects += `<rect x="${x}" y="0" width="${width}" height="${height}"/>`;
      x += width;
    });
  }
  const width = x + 10;
  return {
    kind,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${rects}</svg>`,
  };
}
