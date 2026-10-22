// UPI payment QR codes (sweep SW-X-UPI) and the table's ordering QR on a
// bill (SW-B-08). Plain functions with explicit extensions, so a test can run
// them outside the bundler.
import QRCode from "qrcode";

// The address any UPI app opens to pay: the restaurant's UPI ID (VPA), its
// name as the guest's app shows it, the exact amount in rupees and paise,
// rupees, and the bill number as the note (it lands on the bank statement,
// which is how the cashier matches the payment).
//
//   upi://pay?pa=kirancafe@okhdfcbank&pn=Kiran%20Cafe&am=1240.50&cu=INR&tn=INV-0042
//
// null when there is no UPI ID or nothing to pay.
export const upiPayLink = ({ vpa, payeeName, amount, note }) => {
  const due = Math.round(Number(amount || 0) * 100);

  if (!vpa || !(due > 0)) {
    return null;
  }

  const parts = [
    `pa=${encodeURIComponent(String(vpa).trim()).replace(/%40/g, "@")}`,
    payeeName ? `pn=${encodeURIComponent(String(payeeName).trim().slice(0, 50))}` : null,
    `am=${(due / 100).toFixed(2)}`,
    "cu=INR",
    note ? `tn=${encodeURIComponent(String(note).slice(0, 50))}` : null,
  ].filter(Boolean);

  return `upi://pay?${parts.join("&")}`;
};

// A QR code as an SVG string, drawn at once (the print window is written in
// one go, so no promise can be waited on). Black modules on white with the
// quiet zone, sized by the caller through CSS.
export const qrSvg = (text, { label = "QR code" } = {}) => {
  const qr = QRCode.create(String(text), { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const quiet = 4;
  const full = size + quiet * 2;
  let path = "";

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.modules.get(row, col)) {
        path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
  }

  const title = String(label).replace(/[<>&"]/g, "");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="${title}"><rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
};

// What the guest scans on this bill to pay the amount still due, or null.
export const billUpiLink = (bill) => {
  if (!bill || !bill.upi || bill.billStatus === "void" || bill.billStatus === "paid") {
    return null;
  }

  return upiPayLink({
    vpa: bill.upi.vpa,
    payeeName: bill.upi.payeeName,
    amount: bill.dueAmount,
    note: bill.billNumber,
  });
};

// The table's ordering page, when the bill says to print it (the switch as it
// was when the bill was raised) and the bill is a dine-in at a table with a QR.
export const billTableLink = (bill, origin = "") => {
  const settings = (bill && bill.receiptSettings) || {};

  if (!bill || !settings.printShowQr || !bill.tableQrToken || bill.orderType !== "dine_in") {
    return null;
  }

  const base = String(bill.guestWebAddress || origin || "").replace(/\/+$/, "");

  return base ? `${base}/order/${bill.tableQrToken}` : null;
};
