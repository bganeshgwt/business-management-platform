import { useEffect, useState } from "react";
import api from "../../../../services/api";
import { PhotoButton, SignaturePad } from "../../../tasks/pages/parts";
import "../../../tasks/styles/tasks.css";

// A laundry's pictures: photos of garments at intake and at their quality
// check, and the signature the customer draws on the screen at intake. They
// are private: sent to the server as they are taken and read back only
// through the API by someone who sees the order. The server checks the rest.

// An order's picture, read through the API.
export function LaundryPicture({ biz, fileId, alt, className = "ldy-picture" }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false, made = null;
    api.get(`/businesses/${biz.id}/laundry/files/${fileId}`, { responseType: "blob" })
      .then((response) => { if (!gone) { made = URL.createObjectURL(response.data); setUrl(made); } }).catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [biz.id, fileId]);
  return url ? <img src={url} alt={alt} className={className} loading="lazy" /> : <span className={`${className} skeleton`} aria-label="Loading the picture" />;
}

// A photo button that hands the picture on, as small as the tasks' photos are made.
export { PhotoButton };

// The customer signs on the screen: the signature is handed on as a PNG.
export function SignHere({ onSave, onCancel, words = "The customer signs: the garments and what is noted about them are as on the receipt" }) {
  return (
    <div className="ldy-sign">
      <span className="small">{words}</span>
      <SignaturePad onCancel={onCancel} onSave={onSave} />
    </div>
  );
}
