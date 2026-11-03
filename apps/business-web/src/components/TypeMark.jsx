import Icon from "@bmp/ui/Icon";
import { formatIcon } from "../services/restaurantFormats";

// A business's mark: the icon of its type (or kind) in its accent, as the
// platform set them (Platform › Business types); a restaurant's by its format.
// `look` comes with the business: the directory, or the business's context.
export default function TypeMark({ look, format, size = 16, className = "" }) {
  const icon = format ? formatIcon(format) : look?.icon;
  return (
    <span className={`bsw-type type-accent-${look?.accent || "teal"} ${className}`.trim()} aria-hidden="true">
      <Icon name={icon} fallback="store" size={size} />
    </span>
  );
}
