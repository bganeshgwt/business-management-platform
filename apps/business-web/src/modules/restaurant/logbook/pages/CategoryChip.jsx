import Icon from "@bmp/ui/Icon";
import { CATEGORIES } from "./logbookCategories";

// The kind of a log book entry, as colour, mark and word.
export default function CategoryChip({ category }) {
  const item = CATEGORIES[category] || CATEGORIES.other;

  return (
    <span className={`asw-cat asw-cat-${item.tone}`}>
      <Icon name={item.icon} size={13} /> {item.label}
    </span>
  );
}
