# 01 — Design System and Tokens

## 1. Visual language

Use a restrained, professional business-software visual system. The interface should feel dependable and information-rich without looking crowded. Use a neutral canvas, clear typography, consistent spacing, thin separators and limited semantic color.

### Color tokens

These are proposed initial tokens and must be checked for contrast in implementation.

| Token | Value | Purpose |
|---|---|---|
| `color.canvas` | `#F5F7FA` | App background |
| `color.surface` | `#FFFFFF` | Panels, forms, tables |
| `color.surface.subtle` | `#EEF2F6` | Secondary surface |
| `color.text.primary` | `#17212F` | Main text |
| `color.text.secondary` | `#526173` | Supporting text |
| `color.border` | `#D7DEE7` | Dividers and control borders |
| `color.brand` | `#173D63` | Primary actions and active navigation |
| `color.brand.hover` | `#102F4D` | Hover state |
| `color.focus` | `#0B6E99` | Visible keyboard focus |
| `color.success` | `#176B45` | Confirmed success |
| `color.warning` | `#8A5200` | Needs attention |
| `color.danger` | `#B42318` | Error, destructive action |
| `color.info` | `#175CD3` | Informational state |

Never rely on color alone to communicate a status. Pair color with text and, where useful, an icon.

## 2. Typography

- UI font: system sans-serif stack or a licensed, well-supported sans-serif.
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
  --ep-color-brand: #173D63;
  --ep-color-brand-hover: #102F4D;
  --ep-color-focus: #0B6E99;
  --ep-color-success: #176B45;
  --ep-color-warning: #8A5200;
  --ep-color-danger: #B42318;
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

Tokens are design proposals; contrast and rendered states must be measured before release. Do not hard-code one currency, date format, locale or timezone into components.
