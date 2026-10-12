import Icon from "./Icon";

// A card with a proper heading: an icon in the section's tone, the title, an
// optional line saying what the section is for, and any actions on the right.
// Long forms (settings, a guest's record) split into these read as named
// groups instead of one wall of fields.
//
//   <SectionCard icon="receipt" title="Bill numbering"
//                description="How order and invoice numbers look on paper."
//                actions={<button className="button button-secondary button-sm">Preview</button>}>
//     …fields…
//   </SectionCard>
//
// tone      area (default) | primary | success | warning | danger | info | neutral
// flush     the body has no padding, so a table can run edge to edge
// as        the element to render ("section" by default; "form" for a form card)
// id        passed through, so a page can link to #a-section
// Any other props (onSubmit for a form card, aria-*) go to the outer element.
export default function SectionCard({
  icon,
  title,
  description,
  actions,
  tone = "area",
  flush = false,
  as: Tag = "section",
  className = "",
  bodyClassName = "",
  children,
  ...rest
}) {
  const hasHead = icon || title || description || actions;

  return (
    <Tag className={`card section-card ${flush ? "is-flush" : ""} ${className}`.trim()} {...rest}>
      {hasHead && (
        <div className={`section-card-head tone-${tone}`}>
          {icon && (
            <span className={`section-card-icon tone-${tone}`}>
              {typeof icon === "string" ? <Icon name={icon} size={18} /> : icon}
            </span>
          )}
          <div className="section-card-titles">
            {title && <h2 className="section-card-title">{title}</h2>}
            {description && <p className="section-card-description">{description}</p>}
          </div>
          {actions && <div className="section-card-actions">{actions}</div>}
        </div>
      )}
      <div className={`section-card-body ${bodyClassName}`.trim()}>{children}</div>
    </Tag>
  );
}
