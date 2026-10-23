import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { dayMonth } from "@bmp/shared/dates";
import "../styles/attachments.css";

// The paper bill behind an expense or a supplier's bill: photos or
// PDFs, at most five, each up to 5 MB. Opening a file reads it through the
// signed-in session (the files are never on a public link) and shows it in a
// new tab. On a phone, "Add a photo" offers the camera.
//
//   files       { list(), upload(file), fetchFile(id) -> Blob, remove(id) }
//   canEdit     may add and remove files
//   footer      extra buttons (Approve, when the modal is opened to approve)
//   onChanged   called with the new count after a file is added or removed
const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "application/pdf"];

const sizeText = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function AttachmentsModal({ title, description, files, canEdit, onClose, onChanged, footer }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState({});
  const input = useRef(null);
  const camera = useRef(null);
  const urls = useRef([]);
  const asked = useRef(new Set());

  const load = useCallback(
    () =>
      files
        .list()
        .then((list) => {
          setItems(list);
          setError("");
          return list;
        })
        .catch((err) => setError(getErrorMessage(err))),
    [files]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Small pictures of the photos, read through the session like the files.
  useEffect(() => {
    if (!items) {
      return;
    }

    items
      .filter((item) => item.isImage && !asked.current.has(item.id))
      .forEach((item) => {
        asked.current.add(item.id);
        files
          .fetchFile(item.id)
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            urls.current.push(url);
            setPreviews((current) => ({ ...current, [item.id]: url }));
          })
          .catch(() => undefined);
      });
  }, [items, files]);

  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const view = async (item) => {
    // Opened first, filled after: a window opened after the wait would be
    // stopped as a pop-up.
    const tab = window.open("", "_blank");

    try {
      const blob = await files.fetchFile(item.id);
      const url = URL.createObjectURL(blob);
      urls.current.push(url);

      if (tab) {
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch (err) {
      if (tab) {
        tab.close();
      }

      setError(getErrorMessage(err));
    }
  };

  const add = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    // Said before the upload, so nobody waits for a refusal.
    if (!TYPES.includes(file.type)) {
      setError("Only a photo (JPG or PNG) or a PDF of the bill can be attached.");
      return;
    }

    if (file.size > MAX_BYTES) {
      setError("That file is larger than 5 MB. Take the photo again at a lower size, or save the PDF smaller.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      await files.upload(file);
      const list = await load();
      onChanged?.(list ? list.length : 0);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item) => {
    setBusy(true);
    setError("");

    try {
      await files.remove(item.id);
      const list = await load();
      onChanged?.(list ? list.length : 0);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const full = items && items.length >= MAX_FILES;

  return (
    <Modal title={title} icon="file" description={description} onClose={onClose} width={560} footer={footer}>
      <div className="stack att-body">
        <ErrorMessage message={error} />

        {items === null && !error && <p className="muted">Reading the files…</p>}

        {items && items.length === 0 && (
          <p className="att-empty muted">
            <Icon name="file" size={18} /> No paper bill attached yet.
          </p>
        )}

        {items && items.length > 0 && (
          <ul className="att-list">
            {items.map((item) => (
              <li key={item.id} className="att-item">
                <button type="button" className="att-thumb" onClick={() => view(item)} aria-label={`Open ${item.fileName}`}>
                  {item.isImage && previews[item.id] ? (
                    <img src={previews[item.id]} alt="" />
                  ) : (
                    <Icon name="file" size={22} />
                  )}
                </button>
                <span className="att-meta">
                  <button type="button" className="link-button att-name" onClick={() => view(item)}>
                    {item.fileName}
                  </button>
                  <span className="muted small">
                    {item.isImage ? "Photo" : "PDF"} · {sizeText(item.sizeBytes)} · {dayMonth(item.createdAt, { time: true })}
                    {item.createdByName ? ` · ${item.createdByName}` : ""}
                  </span>
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="button button-ghost button-sm"
                    onClick={() => remove(item)}
                    disabled={busy}
                    aria-label={`Remove ${item.fileName}`}
                  >
                    <Icon name="trash" size={14} /> Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="att-actions">
            <input ref={input} type="file" accept="image/jpeg,image/png,application/pdf" hidden onChange={add} />
            <input ref={camera} type="file" accept="image/jpeg,image/png" capture="environment" hidden onChange={add} />
            <button type="button" className="button button-secondary" onClick={() => camera.current?.click()} disabled={busy || full}>
              <Icon name="upload" size={16} /> Add a photo
            </button>
            <button type="button" className="button button-secondary" onClick={() => input.current?.click()} disabled={busy || full}>
              <Icon name="file" size={16} /> Choose a file
            </button>
            <span className="muted small">
              {full ? "Five files is the most. Remove one to add another." : "JPG, PNG or PDF, up to 5 MB each, five at most."}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
