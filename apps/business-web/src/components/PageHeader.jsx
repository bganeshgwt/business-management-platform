import Icon from "@bmp/ui/Icon";
import ActionMenu from "./ActionMenu";

// The top of every screen: what it is, one line on what it is for, and the
// main thing you can do here on the right.
//
// `action` is the original prop and every page that passes it keeps working;
// `actions` is the same thing under the name the design notes use. `icon` is
// an Icon name (or any element) shown in a tinted square beside the title.
//
// The rule for new and reworked screens — one main button, the rest tucked
// away — is built in:
//
//   <PageHeader title="Products" description="…" icon="products"
//     primary={<button className="button" onClick={add}><Icon name="plus" /> Add product</button>}
//     secondary={<Link className="button button-secondary" to="/menu/print">Print menu</Link>}
//     more={[{ label: "Import from a sheet", icon: "upload", onClick: openImport },
//            { label: "Export", icon: "download", onClick: exportCsv }]} />
//
// primary    the one main action, drawn last (rightmost)
// secondary  at most one or two everyday buttons before it
// more       rarer actions, in a "More" menu (ActionMenu items)
// eyebrow    a small line above the title; Business Admin no longer uses it
//            for the business name — the switcher already names it.
export default function PageHeader({ title, description, action, actions, icon, eyebrow, primary, secondary, more }) {
  const side = action || actions;
  const hasMore = Array.isArray(more) && more.length > 0;
  const hasSide = Boolean(side || primary || secondary || hasMore);

  return (
    <div className="page-header">
      <div className="page-header-main">
        {icon && (
          <span className="page-header-icon" aria-hidden="true">
            {typeof icon === "string" ? <Icon name={icon} size={22} /> : icon}
          </span>
        )}
        <div className="page-header-text">
          {eyebrow && <span className="page-header-eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
          {description && <p className="muted page-header-description">{description}</p>}
        </div>
      </div>
      {hasSide && (
        <div className="page-header-actions">
          {side}
          {secondary}
          {hasMore && <ActionMenu items={more} text="More" label={`More actions: ${typeof title === "string" ? title : "this page"}`} />}
          {primary}
        </div>
      )}
    </div>
  );
}
