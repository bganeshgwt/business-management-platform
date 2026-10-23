import { useEffect, useState } from "react";
import QRCode from "qrcode";
import Icon from "@bmp/ui/Icon";
import { escapeHtml, printDocument } from "../../../services/print";

// The pieces of two-step sign-in that sign-in and My profile share: the box
// the six digits go in, the "scan this with your phone" panel, and the ten
// recovery codes shown once.

// Six digits, typed or pasted ("123 456" and "123-456" work too). On a phone
// the number pad opens, and the phone may offer the code itself.
export function CodeInput({ value, onChange, autoFocus = false, id, label = "6-digit code" }) {
  return (
    <input
      id={id}
      className="staff-code-input"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={7}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
      placeholder="000000"
      aria-label={label}
      autoFocus={autoFocus}
      spellCheck={false}
    />
  );
}

// The QR code for the authenticator app, and the key to type when the
// camera cannot read it. The secret is shown here once, while setting up.
export function ScanPanel({ setup }) {
  const [image, setImage] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;

    QRCode.toDataURL(setup.otpauthUrl, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => {
        if (alive) {
          setImage(url);
        }
      })
      .catch(() => {
        if (alive) {
          setImage("");
        }
      });

    return () => {
      alive = false;
    };
  }, [setup.otpauthUrl]);

  const copyKey = () => {
    navigator.clipboard
      ?.writeText(setup.secret.replace(/\s/g, ""))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="staff-scan">
      <div className="staff-scan-qr">
        {image ? (
          <img src={image} width={180} height={180} alt="QR code for your authenticator app" />
        ) : (
          <span className="skeleton staff-scan-skeleton" />
        )}
      </div>
      <ol className="staff-scan-steps">
        <li>
          <strong>Open Google Authenticator or Microsoft Authenticator</strong> on your phone (free from the app
          store).
        </li>
        <li>
          Tap <strong>+</strong> and <strong>scan the QR code</strong>.
        </li>
        <li>
          Can't scan? Choose <strong>enter a setup key</strong> and type:
          <span className="staff-key-row">
            <code className="staff-key">{setup.secret}</code>
            <button type="button" className="chip-button" onClick={copyKey}>
              <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}
            </button>
          </span>
          <small className="muted">Account: {setup.account} · time-based</small>
        </li>
      </ol>
    </div>
  );
}

// The ten recovery codes, once. Each signs in one time when the phone is
// lost, so they are copied, printed or downloaded and kept somewhere safe.
export function RecoveryCodes({ codes, who }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`Recovery codes for ${who}\nEach code signs in once.\n\n${text}\n`], { type: "text/plain" }));
    link.download = "recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const print = () =>
    printDocument({
      title: "Recovery codes",
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 13px; color: #111; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        ol { columns: 2; font-family: ui-monospace, Consolas, monospace; font-size: 16px; line-height: 2; }
        p { color: #444; }
      `,
      body: `
        <h1>Recovery codes</h1>
        <p>${escapeHtml(who)} · each code signs in once, when your phone is not with you. Keep this sheet somewhere safe.</p>
        <ol>${codes.map((code) => `<li>${escapeHtml(code)}</li>`).join("")}</ol>
      `,
    });

  return (
    <div className="staff-codes">
      <ol className="staff-codes-grid">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className="staff-codes-actions">
        <button type="button" className="button button-secondary button-sm" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy all"}
        </button>
        <button type="button" className="button button-secondary button-sm" onClick={download}>
          <Icon name="download" size={15} /> Download
        </button>
        <button type="button" className="button button-secondary button-sm" onClick={print}>
          <Icon name="print" size={15} /> Print
        </button>
      </div>
      <p className="muted small">
        These are shown only now. Each one signs you in once when your phone is lost or flat; you can make a new set
        under My profile at any time.
      </p>
    </div>
  );
}
