import { useState } from "react";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import { drawing } from "@bmp/ui/drawings";
import { BUSINESS_ACCENTS } from "@bmp/ui/businessIcons";
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

// The logo's web address from Business settings, when it is one a page can show.
const logoAddress = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

// The open business in the product's place (its top bar, its lock screen):
// its own logo when Business settings has one that loads, else its mark
// white on its accent, in the tile of the product's mark.
export function BusinessMark({ look, size = 34, className = "" }) {
  const [broken, setBroken] = useState(null);
  const logo = logoAddress(look?.logo);

  if (logo && broken !== logo) {
    return (
      <span className={`brand-mark brand-logo ${className}`.trim()} style={{ "--mark-size": `${size}px` }}>
        <img src={logo} alt="" onError={() => setBroken(logo)} />
      </span>
    );
  }

  const icon = drawing(look?.icon) ? look.icon : "store";
  return <BrandMark size={size} icon={icon} color={BUSINESS_ACCENTS[look?.accent] || BUSINESS_ACCENTS.teal} className={className} />;
}
