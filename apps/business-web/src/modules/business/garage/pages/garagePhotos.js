import { useEffect, useState } from "react";
import api from "../../../../services/api";

// A job card's photos are private files, read through the API by someone who
// sees the job card (never from a public address).

// The photo's bytes as an address the page can show (and print), freed when the page goes.
export function usePhotoUrl(biz, photoId) {
  const [loaded, setLoaded] = useState({ photoId: null, url: null });
  useEffect(() => {
    if (!photoId) return undefined;
    let gone = false;
    let made = null;
    api.get(`/businesses/${biz.id}/garage/photos/${photoId}`, { responseType: "blob" })
      .then((response) => { if (!gone) { made = URL.createObjectURL(response.data); setLoaded({ photoId, url: made }); } })
      .catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [biz.id, photoId]);
  return loaded.photoId === photoId ? loaded.url : null;
}

// A photo as a data address, for a print that outlives the page.
export async function photoDataUrl(biz, photoId) {
  const response = await api.get(`/businesses/${biz.id}/garage/photos/${photoId}`, { responseType: "blob" });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(response.data);
  });
}
