# @bmp/ui (packages/ui)

The platform's look, shared by both web apps. Source only: the apps' Vite
builds compile it; there is no build step here.

| Import | What it is |
| --- | --- |
| `import "@bmp/ui/styles.css"` | The design tokens (light and dark), element styles and the shared component sheets, in one file. Each app imports it first in its `main.jsx`. The parts: `styles/base.css` (tokens and base, the old `index.css`), `ui.css`, `motion.css`, `colour.css`, `components.css`; each can also be imported alone as `@bmp/ui/styles/<name>.css`. |
| `import Icon, { BrandMark } from "@bmp/ui/Icon"` | The icon set |
| `import ComboChoicePicker from "@bmp/ui/menu/ComboChoicePicker"`, `@bmp/ui/menu/AddonChoiceRules` | A dish's combo and add-on choices, used by the POS and the guest pages |

**What belongs here:** a component or stylesheet that both apps use. Code one
app alone uses stays in that app (`apps/*/src/components`, `src/styles`).
Logic without React (formatting, dates, rules) goes in `@bmp/shared`.
