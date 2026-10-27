import { useEffect, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import api, { getErrorMessage } from "../../../../services/api";
import { businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";

// A piece's photo or a custom order's design. The file is private: it is read
// through the API by someone who may see the pieces, never from a public
// address. A new photo takes the old one's place (the old one is kept).
// pieceId | orderId: what it belongs to; canChange: may add or take it off.
export default function JewelleryPhoto({ biz, fileId, pieceId, orderId, canChange, onChanged, label = "Photo" }) {
  const [loaded, setLoaded] = useState({ fileId: null, url: null });
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => {
    if (!fileId) return undefined;
    let gone = false;
    let made = null;
    api.get(`/businesses/${biz.id}/jewellery/files/${fileId}`, { responseType: "blob" })
      .then((response) => { if (!gone) { made = URL.createObjectURL(response.data); setLoaded({ fileId, url: made }); } })
      .catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [biz.id, fileId]);
  const url = fileId && loaded.fileId === fileId ? loaded.url : null;
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      if (pieceId) form.append("pieceId", String(pieceId));
      if (orderId) form.append("orderId", String(orderId));
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
  return (
    <figure className="jw-photo">
      {url ? <img src={url} alt={label} /> : <div className="jw-photo-empty"><Icon name="file" size={20} /><span>No {label.toLowerCase()} yet</span></div>}
      {canChange && (
        <figcaption>
          <label className={`button button-secondary ${busy ? "is-busy" : ""}`}>
            <Icon name="upload" size={15} /> {fileId ? `A new ${label.toLowerCase()}` : `Add a ${label.toLowerCase()}`}
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          {fileId && <button type="button" className="link-button danger" disabled={busy} onClick={remove}>Take it off</button>}
          <small className="muted">JPG, PNG or WebP, up to 5 MB.</small>
        </figcaption>
      )}
    </figure>
  );
}
