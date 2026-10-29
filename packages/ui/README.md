# @bmp/ui (packages/ui)

For developers of both web apps: the shared look (the stylesheets and their
design tokens), the icons, the menu choice components and the routes' error
boundary, and what belongs in this package.

The platform's look, shared by both web apps. Source only: the apps' Vite
builds compile it; there is no build step here.

| Import | What it is |
| --- | --- |
| `import "@bmp/ui/styles.css"` | Every shared stylesheet in one file, in the order below. Each app imports it first in its `main.jsx`, so a page's own stylesheet comes after it and wins where the two disagree. Each part can also be imported alone as `@bmp/ui/styles/<name>.css`. The staff app imports its own part straight after ([below](#the-staff-apps-own-part)). |
| `import Icon, { BrandMark } from "@bmp/ui/Icon"` | The icon set (`<Icon name="…" />`) and the product's mark |
| `import ComboChoicePicker from "@bmp/ui/menu/ComboChoicePicker"`, `@bmp/ui/menu/AddonChoiceRules` | A dish's combo and add-on choices, used by the POS and the guest pages |
| `import PageLoadBoundary from "@bmp/ui/PageLoadBoundary"` | Around each app's routes (`<PageLoadBoundary resetKey={pathname}>`): a page whose code fails to load (a new version gone live while the tab was open) reloads once by itself, remembered for that address in the tab (`@bmp/shared/pageLoad`); a second failure, or any other error while drawing a page, shows a short message with a *Reload* button, never a blank screen, and the error is still reported as uncaught (`reportError`). Going to another address tries again. |

## Stylesheets

`styles.css` (`src/styles/index.css`) loads five sheets from `src/styles/`, in
this order.

**`base.css`: the tokens, the elements and the kit.**

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
- Then the elements and the kit any page of either app may use: headings and
  text helpers, forms and fields, messages, buttons, cards, dialogs, empty
  states, and a combo's choices (`.service-option-card`, `.service-choice`),
  which the guest pages use too.

**`ui.css`: shared components.** Loading states and inputs with an icon.

**`motion.css`: movement.** The motion tokens (durations such as
`--motion-fast` 140 ms, `--motion-enter` 340 ms and `--motion-stagger` 32 ms a
cascade step, and the easing curves), the keyframes, and every rule that
animates by itself, for what both apps use (presses, dialogs, messages,
loading); the staff app's own movement is in its part. Three rules hold
everywhere:

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
`--bright-<name>` (for the dark sidebar), with dark-mode values, and the
guests' service shortcuts on the QR page. They never replace the status,
food-type, kitchen-station or payment-status colours.

**`components.css`: more shared components.** Toasts, form fields and inline
errors, and the message of a page that cannot be shown (`PageLoadBoundary`).
Sizes come from the tokens in `base.css`.

## The staff app's own part

The rules only staff screens use are in the staff app, `apps/business-web/src/styles/app/`,
which its `main.jsx` imports straight after `styles.css`; the guests' site
never loads them. Each sheet there holds the staff-only rules of the sheet of
the same name here, in their order: in `base.css` the page header's frame, the
shell and side menu, tables and row actions, badges, the dashboard's tiles,
the POS, charts, the floor plan, report tabs and printing; in `ui.css` the
tones (`.tone-primary` … `.tone-violet`, each setting `--tone` and
`--tone-bg` for a component to read), the page header, stat tiles, section
cards, the sign-in page and the not-found page; in `motion.css` the menu's,
the page entrances', the charts' and the live figures' movement; in
`colour.css` an area's accent (an element with `data-accent="<name>"` sets
`--area-ink`, `--area-tint` and `--area-bright` for everything inside it,
`.tone-area` reads them, and the staff app picks a page's accent from its path,
`services/pageAccent.js`); in `components.css` stat-tile figures, the search
picker, the skip link, the page header's "More" menu and the settings layout.

So the staff app sees every shared rule first and then its own. A staff-only
rule that a later shared rule must still override (its transition, or a
field's red edge) stays here, before that rule, with a note saying why.

## What belongs here

A component or stylesheet that both apps use. Code one app alone uses stays in
that app (`apps/*/src/components`, `src/styles`). A new rule goes in these
sheets when the guests' site uses it or it belongs to the kit (buttons,
fields, cards, the dialog, messages, loading); a rule only staff screens use
goes in the staff app's `src/styles/app`. Logic without React (formatting,
dates, rules) goes in `@bmp/shared`.
