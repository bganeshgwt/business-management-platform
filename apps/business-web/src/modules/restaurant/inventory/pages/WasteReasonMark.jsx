// The mark of each waste reason: one per reason, so a reason reads the same
// everywhere without relying on its colour. Waste & reorder draws them on its
// reason chips and pickers, and Items & stock on the Stock out dialog's
// reasons, so the two screens that write waste off look alike.
const PATHS = {
  spoiled: <path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z" />,
  expired: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4" />
    </>
  ),
  overcooked: (
    <path d="M12 22c4 0 7-3 7-7 0-3-2-5.5-3.5-7-.3 2-1.5 3.5-3 4 .5-3-1-6.5-4-9 0 3.5-3.5 6-3.5 11 0 4 3 8 7 8z" />
  ),
  dropped: <path d="M12 3v12M6 9l6 6 6-6M5 21h14" />,
  returned: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </>
  ),
  over_prepped: (
    <>
      <path d="m12 2 10 5-10 5L2 7z" />
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  other: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  unspecified: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
};

export default function WasteReasonMark({ reason, size = 14 }) {
  const path = PATHS[reason];

  if (!path) {
    return null;
  }

  return (
    <svg
      className="ii-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}
