import { useEffect, useRef, useState } from "react";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { getPunchPhoto, getTimeclockSettings, saveTimeclockSettings } from "../services/timeclock.service";
import { getErrorMessage } from "../../../../services/api";

// A photo with each time-clock punch: one person punching in for another
// with a shared PIN is the time clock's oldest trick.
//
//   PunchCamera          the tablet's camera, shown while someone chooses
//                        clock in / break / clock out; a frame is taken at
//                        the punch
//   PunchPhoto           the picture beside a punch on the day's timeline
//   PunchPhotoSettings   switching it on, and how long photos are kept

const SIZE = 240;

// The live camera, in a circle. `captureRef.current()` returns the frame as a
// small JPEG (a 240 px square, about 15 KB), or null when there is no camera
// — the punch then goes through, marked "no photo".
export function PunchCamera({ captureRef }) {
  const videoRef = useRef(null);
  const [state, setState] = useState("starting");

  useEffect(() => {
    let stream = null;
    let alive = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      Promise.resolve().then(() => alive && setState("none"));
      return undefined;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } }, audio: false })
      .then((media) => {
        if (!alive) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }

        stream = media;

        if (videoRef.current) {
          videoRef.current.srcObject = media;
          videoRef.current.play().catch(() => undefined);
        }

        setState("live");
      })
      .catch(() => alive && setState("none"));

    return () => {
      alive = false;

      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    captureRef.current = () => {
      const video = videoRef.current;

      if (state !== "live" || !video || !video.videoWidth) {
        return null;
      }

      // The middle square of the picture, scaled down.
      const side = Math.min(video.videoWidth, video.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      canvas
        .getContext("2d")
        .drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);

      try {
        return canvas.toDataURL("image/jpeg", 0.72);
      } catch {
        return null;
      }
    };

    return () => {
      captureRef.current = null;
    };
  }, [captureRef, state]);

  return (
    <div className={`asw-camera is-${state}`}>
      <div className="asw-camera-frame">
        <video ref={videoRef} muted playsInline aria-label="Camera" />
        {state !== "live" && (
          <span className="asw-camera-off">
            <Icon name={state === "none" ? "eye-off" : "eye"} size={22} />
          </span>
        )}
      </div>
      <span className="small">
        {state === "live"
          ? "Look at the camera: a photo is taken with your punch"
          : state === "starting"
            ? "Starting the camera…"
            : "No camera: your punch is saved without a photo"}
      </span>
    </div>
  );
}

// A punch's photo, fetched with the session (it is never a public file).
export function PunchPhoto({ punchId, status, hasPhoto }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasPhoto) {
      return undefined;
    }

    let objectUrl = null;
    let alive = true;

    getPunchPhoto(punchId)
      .then((blob) => {
        if (alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => alive && setFailed(true));

    return () => {
      alive = false;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [punchId, hasPhoto]);

  if (!status) {
    return null;
  }

  if (status === "missing") {
    return (
      <span className="asw-photo-tag is-missing" title="The tablet's camera could not take a photo; the punch still counts">
        <Icon name="eye-off" size={12} /> No photo
      </span>
    );
  }

  if (!hasPhoto || failed) {
    return (
      <span className="asw-photo-tag" title="Photos are deleted after the keeping time">
        <Icon name="eye-off" size={12} /> Photo deleted
      </span>
    );
  }

  return (
    <>
      <button type="button" className="asw-photo-thumb" onClick={() => setOpen(!open)} aria-label="Photo taken with this punch" aria-expanded={open}>
        {url ? <img src={url} alt="" width={32} height={32} /> : <span className="skeleton" />}
      </button>
      {open && url && (
        <span className="asw-photo-large motion-tooltip">
          <img src={url} alt="Photo taken with this punch" width={180} height={180} />
        </span>
      )}
    </>
  );
}

export function PunchPhotoSettings() {
  const [settings, setSettings] = useState(null);
  const [keepDays, setKeepDays] = useState("60");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getTimeclockSettings()
      .then((data) => {
        setSettings(data);
        setKeepDays(String(data.photoKeepDays));
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const save = async (punchPhotos) => {
    setBusy(true);
    setError("");
    setSuccess("");

    try {
      const result = await saveTimeclockSettings({ punchPhotos, photoKeepDays: Number(keepDays || 60) });
      setSettings(result.data);
      setSuccess(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      icon="eye"
      tone={settings && settings.punchPhotos ? "success" : "neutral"}
      title="Take a photo at each punch"
      description="The tablet's camera takes a small photo with every clock in, break and clock out, so nobody can punch for someone else with their PIN. Managers see it on the day's timeline."
      actions={
        settings && (
          <span className={`badge status-badge ${settings.punchPhotos ? "badge-active" : "badge-neutral"}`}>
            <span className="badge-dot" aria-hidden="true" />
            {settings.punchPhotos ? "On" : "Off"}
          </span>
        )
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />
        <SuccessMessage message={success} />
        <div className="asw-photo-settings">
          <label className="field">
            <span>Delete photos after (days)</span>
            <input type="number" min="1" max="365" value={keepDays} onChange={(event) => setKeepDays(event.target.value)} />
          </label>
          <p className="muted small">
            If the tablet has no camera, or it is covered, the punch still goes through and is marked "no photo". Only
            people who can see staff records can see the photos.
          </p>
        </div>
        <div className="form-actions asw-actions-left">
          {settings && settings.punchPhotos ? (
            <>
              <button type="button" className="button" onClick={() => save(true)} disabled={busy || String(settings.photoKeepDays) === keepDays}>
                Save
              </button>
              <button type="button" className="button button-secondary" onClick={() => save(false)} disabled={busy}>
                Switch photos off
              </button>
            </>
          ) : (
            <button type="button" className="button" onClick={() => save(true)} disabled={busy || !settings}>
              <Icon name="eye" size={15} /> Switch photos on
            </button>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
