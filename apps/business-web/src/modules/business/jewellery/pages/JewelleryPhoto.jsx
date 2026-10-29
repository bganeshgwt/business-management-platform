import { useEffect, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import api, { getErrorMessage } from "../../../../services/api";
import { businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";

// A piece's photo, a custom order's design, a photo of old gold taken in, or
// the copy of a KYC document (a photo or a PDF). The file is private: it is
// read through the API by someone who may see it, never from a public
// address. A new photo of a piece, a design or a KYC copy takes the old one's
// place (the old one is kept); old gold keeps several photos, each added on
// its own (replaces: false).
// pieceId | orderId | oldGoldId | kycId: what it belongs to; canChange: may add or take it off; pdf: a PDF may be added.
export default function JewelleryPhoto({ biz, fileId, pieceId, orderId, oldGoldId, kycId, canChange, onChanged, label = "Photo", pdf = false, replaces = true }) {
  const [loaded, setLoaded] = useState({ fileId: null, url: null, type: "" });
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => {
    if (!fileId) return undefined;
    let gone = false;
    let made = null;
    api.get(`/businesses/${biz.id}/jewellery/files/${fileId}`, { responseType: "blob" })
      .then((response) => { if (!gone) { made = URL.createObjectURL(response.data); setLoaded({ fileId, url: made, type: response.data.type || "" }); } })
      .catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [biz.id, fileId]);
  const url = fileId && loaded.fileId === fileId ? loaded.url : null;
  const isPdf = url && loaded.type === "application/pdf";
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      if (pieceId) form.append("pieceId", String(pieceId));
      if (orderId) form.append("orderId", String(orderId));
      if (oldGoldId) form.append("oldGoldId", String(oldGoldId));
      if (kycId) form.append("kycId", String(kycId));
      form.append("file", file);
      await api.post(`/businesses/${biz.id}/jewellery/files`, form);
      toast.success(`${label} saved.`);
      onChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await businessWrite(biz.id, `jewellery/files/${fileId}`, undefined, "delete");
      toast.success(`${label} taken off.`);
      onChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const adds = !fileId || replaces;
  return (
    <figure className="jw-photo">
      {isPdf ? <a className="jw-photo-empty" href={url} target="_blank" rel="noopener noreferrer"><Icon name="file" size={20} /><span>Open the PDF</span></a>
        : url ? <img src={url} alt={label} />
          : <div className="jw-photo-empty"><Icon name="file" size={20} /><span>{fileId ? "Opening…" : `No ${label.toLowerCase()} yet`}</span></div>}
      {canChange && (
        <figcaption>
          {adds && (
            <label className={`button button-secondary ${busy ? "is-busy" : ""}`}>
              <Icon name="upload" size={15} /> {fileId ? `A new ${label.toLowerCase()}` : `Add a ${label.toLowerCase()}`}
              <input ref={input} type="file" accept={`image/jpeg,image/png,image/webp${pdf ? ",application/pdf" : ""}`} hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          )}
          {fileId && <button type="button" className="link-button danger" disabled={busy} onClick={remove}>Take it off</button>}
          {adds && <small className="muted">JPG, PNG or WebP{pdf ? " or a PDF" : ""}, up to 5 MB.</small>}
        </figcaption>
      )}
    </figure>
  );
}
