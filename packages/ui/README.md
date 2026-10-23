# @bmp/ui (packages/ui)

For developers of both web apps: the shared look (the stylesheets and their
design tokens), the icons and the menu choice components, and what belongs in
this package.

The platform's look, shared by both web apps. Source only: the apps' Vite
builds compile it; there is no build step here.

| Import | What it is |
| --- | --- |
| `import "@bmp/ui/styles.css"` | Every shared stylesheet in one file, in the order below. Each app imports it first in its `main.jsx`, so a page's own stylesheet comes after it and wins where the two disagree. Each part can also be imported alone as `@bmp/ui/styles/<name>.css`. |
| `import Icon, { BrandMark } from "@bmp/ui/Icon"` | The icon set (`<Icon name="…" />`) and the product's mark |
| `import ComboChoicePicker from "@bmp/ui/menu/ComboChoicePicker"`, `@bmp/ui/menu/AddonChoiceRules` | A dish's combo and add-on choices, used by the POS and the guest pages |

## Stylesheets

`styles.css` (`src/styles/index.css`) loads five sheets from `src/styles/`, in
this order.

**`base.css`: the tokens, the elements and the app's frame.**

- The design tokens open the file, on `:root`: surfaces (`--bg`, `--surface`,
  `--surface-2`, `--surface-3`), text (`--text`, `--text-2`, `--muted`),
  borders, the brand (`--primary`, `--primary-soft`), the status tones
  (`--danger`, `--success`, `--warning`, `--info`, each with a tinted `-bg`
  and a `-border`), radii (`--radius-*`), type sizes (`--text-xs` to
  `--text-2xl`), weights (`--weight-*`), spacing (`--space-1` to `--space-8`),
  shadows (`--shadow-*`) and fonts.
- Dark mode: a `@media (prefers-color-scheme: dark)` block redefines every
  token, so a page written with the tokens is complete in both themes. The
  device's setting decides.
- The rules: pages use `var(--…)` and never restate a hex value. Colour is never
  the only signal: a status also has a word, and usually an icon.
- Then the elements and the frame (headings, forms, messages, buttons, the
  shell and sidebar, tables, dialogs) and the parts several screens share: the
  POS, the floor plan, charts, report tabs, row actions, printing.

**`ui.css`: shared components.** The tones (`.tone-primary`, `.tone-success`,
`.tone-warning`, `.tone-danger`, `.tone-info`, `.tone-neutral`,
`.tone-violet`; each sets `--tone` and `--tone-bg` for a component to read),
the page header, stat tiles, section cards, loading states, inputs with an
icon, the sign-in page and the not-found page.

**`motion.css`: all movement.** The motion tokens (durations such as
`--motion-fast` 140 ms, `--motion-enter` 340 ms and `--motion-stagger` 32 ms a
cascade step, and the easing curves), the keyframes, and every rule that
animates by itself. Three rules hold everywhere:

1. Only `transform` and `opacity` move (`clip-path` and `stroke-dashoffset`
   for drawing), never width, height, top or left.
2. Nothing waits for an animation before it can be clicked or typed into.
   Feedback takes 120–200 ms, an entrance 260–420 ms, and a cascade at most
   8 steps.
3. `prefers-reduced-motion: reduce` turns it all off. State changes stay
   instant and visible, and focus rings never animate away.

Figures never count through invented amounts. The script half is in the staff
app: `src/components/motion.js` (the timings in milliseconds, `play`,
`shake`) and the hooks built on it, `useMotionScope` (page transitions,
cascades, sliding pills), `useSidebarMotion`, `usePresence`, `useShake`, and
`useLiveChange` behind `<LiveValue>` (live values).

**`colour.css`: module colours.** Decorative colours that tell the areas apart:
teal, blue, amber, orange, cyan, green, violet, rose and indigo, each as
`--colour-<name>` (ink, for light surfaces), `--tint-<name>` and
`--bright-<name>` (for the dark sidebar), with dark-mode values. An element
with `data-accent="<name>"` sets `--area-ink`, `--area-tint` and
`--area-bright` for everything inside it, and `.tone-area` reads them; the
staff app picks a page's accent from its path (`services/pageAccent.js`). They
never replace the status, food-type, kitchen-station or payment-status colours.

**`components.css`: more shared components.** Stat-tile figures that never
break over two lines, toasts, form fields and inline errors, the search picker,
the skip link, the page header's "More" menu and the settings layout. Sizes
come from the tokens in `base.css`.

## What belongs here

A component or stylesheet that both apps use. Code one app alone uses stays in
that app (`apps/*/src/components`, `src/styles`). Logic without React
(formatting, dates, rules) goes in `@bmp/shared`.
