import "../styles/crm.css";

const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

// A guest's initials in a soft circle. The colour comes from the record's id,
// so the same guest wears the same colour in the book, their history and the
// pickers, and two guests side by side are told apart at a glance.
export default function GuestAvatar({ guest, size }) {
  const id = Number(guest && guest.id);
  const tone = Number.isFinite(id) ? id % 6 : 0;

  return (
    <span className={`crm-avatar crm-avatar-${tone}${size === "lg" ? " crm-avatar-lg" : ""}`} aria-hidden="true">
      {initials(guest && guest.name)}
    </span>
  );
}
