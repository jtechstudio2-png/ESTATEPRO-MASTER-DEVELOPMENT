# 01 — Design System and Tokens

## 1. Visual language

Use a restrained, professional business-software visual system. The interface should feel dependable and information-rich without looking crowded. Use a neutral canvas, clear typography, consistent spacing, thin separators and limited semantic color.

### Color tokens

Contrast ratios below were calculated with the WCAG 2.x relative-luminance formula against each background. Rendered components must still be checked in the browser, because anti-aliasing, opacity and font weight change perceived contrast.

| Token | Value | Purpose |
|---|---|---|
| `color.canvas` | `#F5F7FA` | App background |
| `color.surface` | `#FFFFFF` | Panels, forms, tables |
| `color.surface.subtle` | `#EEF2F6` | Secondary surface |
| `color.text.primary` | `#17212F` | Main text |
| `color.text.secondary` | `#526173` | Supporting text |
| `color.border` | `#D7DEE7` | Decorative dividers and table row lines only (1.36:1, not for control boundaries) |
| `color.border.control` | `#7B8899` | Input, select, checkbox and button outlines (3.61:1 on surface, 3.36:1 on canvas; meets WCAG 1.4.11) |
| `color.brand` | `#173D63` | Primary actions and active navigation |
| `color.brand.hover` | `#102F4D` | Hover state |
| `color.focus` | `#0B6E99` | Visible keyboard focus |
| `color.success` | `#176B45` | Confirmed success |
| `color.warning` | `#8A5200` | Needs attention |
| `color.danger` | `#B42318` | Error, destructive action |
| `color.info` | `#175CD3` | Informational state |

Never rely on color alone to communicate a status. Pair color with text and, where useful, an icon.

### Measured contrast

| Foreground | on `surface` #FFFFFF | on `canvas` #F5F7FA | on `surface.subtle` #EEF2F6 | Result |
|---|---:|---:|---:|---|
| `text.primary` | 16.22 | 15.11 | 14.41 | AA and AAA text |
| `text.secondary` | 6.33 | 5.90 | 5.63 | AA text |
| `brand` (also white text on brand: 11.15) | 11.15 | 10.39 | 9.91 | AA text |
| `focus` | 5.67 | 5.28 | 5.04 | Meets 3:1 focus-indicator contrast |
| `success` | 6.51 | 6.07 | 5.79 | AA text |
| `warning` | 6.39 | 5.95 | 5.68 | AA text |
| `danger` (also white text on danger: 6.57) | 6.57 | 6.13 | 5.84 | AA text |
| `info` | 5.99 | 5.58 | 5.32 | AA text |
| `border` | 1.36 | 1.26 | 1.20 | Decorative only |
| `border.control` | 3.61 | 3.36 | — | Meets 3:1 non-text contrast |

### Status colour mapping

Status labels use the semantic colour for the text and a 1 px border in the same colour on `surface`, never a filled saturated pill. The label text always states the status.

| Semantic | Statuses (from the Phase 2 lifecycles) |
|---|---|
| `success` | Listing: available · Lease: active · Payment: cleared · Work order: completed, closed · Document: clean · Deal: won |
| `info` | Listing: reserved, under contract · Lease: pending signature, periodic · Deal: open stages · Work order: assigned, in progress |
| `warning` | Unit: under maintenance · Lease: notice given, renewal pending decision · Payment: pending (incl. post-dated cheque) · Work order: awaiting approval, on hold · SLA due within 25% of target |
| `danger` | Arrears > 30 days · Payment: bounced · Work order: SLA breached · Document: infected, expired · Deal: lost |
| neutral (`text.secondary`) | Draft, withdrawn, expired listing, cancelled, archived, ended, closed lease |

A listing card shows the listing status and, when it is not `available`, the unit availability next to it, e.g. **Available · Under maintenance**. That way "Under Maintenance" appears to users as a status without breaking the sale/rent lifecycle.

## 2. Typography

- UI font: system sans-serif stack (`system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif`), with `"Noto Sans Arabic"` (or the platform Arabic UI font) first in the stack when the locale is Arabic. Both have full Latin and Arabic coverage and need no licence fees.
- Body default: 14–16 px depending on density and viewport.
- Table text: target 14 px minimum; do not shrink important data to fit.
- Page title: 24–28 px desktop, 22–24 px tablet, 20–22 px mobile.
- Section heading: 16–18 px, medium/semibold.
- Helper text: 12–14 px; never use low contrast for essential instructions.
- Numeric columns use tabular numerals; align amounts and quantities consistently.
- Use sentence case for navigation, labels and buttons. Avoid all-caps labels.

## 3. Spacing, geometry and elevation

| Token | Value | Usage |
|---|---:|---|
| `space.1` | 4 px | Icon/text gap |
| `space.2` | 8 px | Compact control spacing |
| `space.3` | 12 px | Form groups |
| `space.4` | 16 px | Standard spacing |
| `space.5` | 20 px | Section separation |
| `space.6` | 24 px | Large section separation |
| `space.8` | 32 px | Page-level grouping |
| `radius.control` | 6 px | Inputs and buttons |
| `radius.panel` | 8 px | Panels and dialogs |
| `border.default` | 1 px | Standard border |
| `shadow.overlay` | restrained | Menus/dialogs only |

Use borders and spacing before shadows. Avoid stacked cards when a single table or grouped section is clearer. No glass effects or decorative gradients.

## 4. Density modes

**Default: Comfortable operational density.** Use compact table rows while preserving legibility and touch targets. If a compact mode is added, it must be user-selectable and must not reduce mobile touch targets or accessibility.

- Table rows: 48–56 px desktop default; compact mode may use 40–44 px after usability testing.
- Mobile list rows: 64 px or more when multiple actions are present.
- Form controls: 40–44 px desktop; 44 px minimum touch target target on touch interfaces.
- Dense screens should prioritize columns, filters and actions, not reduce font size.

## 5. Operational data-density rules

- Show only fields that support the current decision or task.
- Use column chooser and saved views for specialist columns.
- Keep record name and status visible when horizontal scrolling.
- Freeze important table headers; use pagination or virtualized lists for large datasets.
- Default sort should be task-relevant (e.g. due date, overdue first), and visible to the user.
- Filters must be removable individually and have a clear reset action.
- Preserve filters when navigating back from a record.
- Use badges sparingly for meaningful statuses, never as decoration.
- Charts are allowed only when they answer a defined operational question and include a clear date range, units and data source.
- Every KPI links to the underlying filtered records; no dead-end numbers.
- Empty states explain why there is no data and provide a relevant next action.

## 6. Design token implementation format

Keep tokens centralized. Example CSS custom properties:

```css
:root {
  --ep-color-canvas: #F5F7FA;
  --ep-color-surface: #FFFFFF;
  --ep-color-surface-subtle: #EEF2F6;
  --ep-color-text-primary: #17212F;
  --ep-color-text-secondary: #526173;
  --ep-color-border: #D7DEE7;
  --ep-color-border-control: #7B8899;
  --ep-color-brand: #173D63;
  --ep-color-brand-hover: #102F4D;
  --ep-color-focus: #0B6E99;
  --ep-color-success: #176B45;
  --ep-color-warning: #8A5200;
  --ep-color-danger: #B42318;
  --ep-color-info: #175CD3;
  --ep-font-size-100: 12px;   /* helper text, table meta */
  --ep-font-size-200: 14px;   /* table text, dense body */
  --ep-font-size-300: 16px;   /* body, form inputs (prevents iOS zoom) */
  --ep-font-size-400: 18px;   /* section headings */
  --ep-font-size-600: 24px;   /* page titles (desktop) */
  --ep-line-height-tight: 1.25;
  --ep-line-height-body: 1.5;
  --ep-control-height: 40px;  /* 44px on coarse pointers */
  --ep-row-height: 48px;
  --ep-motion-duration: 120ms; /* state changes only; 0ms under prefers-reduced-motion */
  --ep-space-1: 4px;
  --ep-space-2: 8px;
  --ep-space-3: 12px;
  --ep-space-4: 16px;
  --ep-space-5: 20px;
  --ep-space-6: 24px;
  --ep-radius-control: 6px;
  --ep-radius-panel: 8px;
  --ep-border-width: 1px;
}
```

Do not hard-code one currency, date format, locale or timezone into components.

## 7. Right-to-left (Arabic) support

Qatar users may work in Arabic. The design system supports RTL from the start rather than as a retrofit:

- Set `dir` and `lang` on the `<html>` element from the user's locale (`locales.text_direction` in the database).
- Use CSS logical properties only (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`), never `left`/`right` for layout.
- Mirror directional icons (back, forward, chevrons, progress) in RTL; do not mirror logos, media controls, charts' time axes or phone numbers.
- Numbers, currency amounts, references (`LSE-2026-000042`), emails and phone numbers are isolated with `<bdi>` or `unicode-bidi: isolate`, so mixed Arabic/Latin lines read correctly.
- Tables mirror column order in RTL; the record-name column stays at the inline start.
- Listing text is edited per language (`listing_translations`); the form shows both languages side by side on desktop and as tabs on mobile.
- Dates use the user's locale formatting through `Intl.DateTimeFormat`; the Gregorian calendar is the default for all locales (Hijri display is a later, optional setting).
