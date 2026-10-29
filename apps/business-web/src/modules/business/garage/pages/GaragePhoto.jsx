import { useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import api, { getErrorMessage } from "../../../../services/api";
import { usePhotoUrl } from "./garagePhotos";
import { toast } from "../../../../services/toast";

// A job card's photos: private files read through the API by someone who sees
// the job card (never from a public address), and a button to add one (of an
// inspection item, or of the work), taken with the phone's camera or chosen.

export function GaragePhoto({ biz, photo }) {
  const url = usePhotoUrl(biz, photo.id);
  return (
    <figure className="gar-photo">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={photo.caption || photo.file_name} /></a>
        : <div className="gar-photo-empty"><Icon name="file" size={18} /><span>Opening…</span></div>}
      {photo.caption && <figcaption className="small">{photo.caption}</figcaption>}
    </figure>
  );
}

// Adds a photo to a job card (of an inspection item when itemId is given), with its caption.
export function AddPhoto({ biz, jobId, itemId, label = "Add a photo", caption = "", onAdded }) {
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("jobCardId", String(jobId));
      if (itemId) form.append("inspectionItemId", String(itemId));
      if (caption && caption.trim()) form.append("caption", caption.trim().slice(0, 200));
      form.append("file", file);
      await api.post(`/businesses/${biz.id}/garage/photos`, form);
      toast.success("Photo added.");
      onAdded?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <label className={`button button-secondary button-sm ${busy ? "is-busy" : ""}`}>
      <Icon name="upload" size={14} /> {busy ? "Adding…" : label}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
    </label>
  );
}
