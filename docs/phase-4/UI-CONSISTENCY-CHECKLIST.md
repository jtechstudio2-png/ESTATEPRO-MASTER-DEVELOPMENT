# UI Consistency Checklist

| | |
|---|---|
| Applies to | Every screen of the staff web app (`apps/web`), from Milestone 6 onwards |
| Sources | Phase 3 design set (`docs/phase-3-ui-ux/` 01, 04, 07); [M6 wireframes](./M6-WIREFRAMES.md); [M6 verification report](./M6-WEB-INTERFACE-VERIFICATION.md) §11–16; ADR-002 (WCAG 2.2 AA), ADR-003 (API conventions), ADR-004 to ADR-006 |
| How to use | A screen is done only when every applicable item is ticked in its pull request. Items marked **(test)** are checked automatically by the end-to-end or unit tests; the rest are reviewed by hand. "N/A" needs a one-line reason. |

The shared components named below exist so that each rule is implemented once. A screen that re-implements one of them instead of using it fails the review.

## 1. Tables (`DataTable`)

- [ ] The record identifier (reference and name) is the first column and links to the record. Status is second when the record has one. Row actions are last.
- [ ] Real `<table>` markup: `<caption>` (visible or visually hidden) naming the list, `<th scope="col">` headers, and one `<th scope="row">` per row (the identifier cell). **(test: axe)**
- [ ] Numbers, amounts and dates are right-aligned (end-aligned in RTL) with tabular numerals. Every amount carries its currency; amounts in different currencies are never summed.
- [ ] Dates within 7 days are relative ("in 3 d"), with the absolute date in `title` and in screen-reader text. Older dates are absolute. Times show their time zone when it differs from the user's.
- [ ] The active sort is stated above the table ("Sorted by: Last updated, newest first") and on the header (`aria-sort`). Only sorts the API allows are offered. **(test)**
- [ ] One primary row action is visible. The rest are in a "More actions for {record}" menu. No action appears only on hover.
- [ ] Row click opens the record. Ctrl/Cmd-click and middle-click open a new tab, because the identifier is a real link.
- [ ] On screens narrower than 768 px, the table becomes a card list with the identifier, status, two key fields and one action (`MobileRecordList`). The page never scrolls sideways at 320 px. **(test)**
- [ ] Wide tables scroll inside a labelled region (`role="region"`, `aria-label`, `tabindex="0"`), and the identifier column stays visible.

## 2. Filters (`FilterBar`, `ActiveFilterChips`)

- [ ] Filters, sort, search text and the cursor are kept in the URL, so Back, refresh and shared links restore the view. **(test)**
- [ ] The three or four most-used filters are visible; the rest are under "More filters".
- [ ] Each active filter shows as a removable chip named "Remove filter: {name} {value}", and "Clear all" resets them. Removing a chip returns focus to the next chip or to the filter bar.
- [ ] The scope filter (Mine / Office / All) is first and offers only the scopes the role has.
- [ ] Filter options (offices, agents, types) come from data the user can see. No option reveals hidden records.
- [ ] A price filter requires one currency; the control explains why (the API refuses otherwise).
- [ ] Text search starts at 2 characters, is debounced by 300 ms, and discards stale responses.
- [ ] The filtered-empty state lists the active filters and offers "Clear filters" (§7).
- [ ] Location filters (near, radius, area, polygon) use `LocationFilter`, show the area in words ("Within 2 km of Osu Court"), and can be cleared like any other filter.

## 3. Pagination (`Pagination`, cursor-based)

- [ ] Lists use the API's cursor (`page.nextCursor`) with "Load more", or "Next" and "Previous" from a cursor stack kept in the URL. Page numbers are never invented.
- [ ] The default page size is 50; users may choose 25, 50 or 100 where the API allows.
- [ ] A count is shown only when it is known ("50 shown", "50+"); no estimated totals.
- [ ] After "Load more", focus stays on the button (or moves to the first new row), and a polite live region announces "50 more properties loaded". **(test)**
- [ ] Changing a filter or sort resets the cursor.
- [ ] Map results are not paginated: they show points, or clusters above 500 (ADR-006 L-D4), and the side list uses the list endpoint's pagination.

## 4. Dialogs and drawers (`Dialog`, `ConfirmDialog`, `Drawer`)

- [ ] Built on the accessible dialog primitive: `role="dialog"` or `alertdialog`, an accessible name from the visible title, focus moved inside on open, focus trapped, Escape closes, and focus returns to the trigger on close. **(test)**
- [ ] The confirm button names the action and the object ("Archive Osu Court", "Redact note"), never just "OK".
- [ ] Destructive or irreversible actions (delete media now, redact, retire keys, terminal listing statuses) use `ConfirmDialog` with the danger style and state the consequence in one sentence. Irreversible deletion also requires typing a confirmation word.
- [ ] Required reasons (archive, status changes, price reductions, lost keys) are labelled fields inside the dialog. They are validated before submission and again by the API.
- [ ] A dialog that submits keeps its entered values when the API returns an error, and shows the error inside the dialog.
- [ ] Dialogs fit at 320 px and 200% zoom; on mobile, long forms open as a full-screen page instead.
- [ ] Opening a dialog never fetches data that the trigger could not show (for example, no listing of staff for a user without `listing.update`).

## 5. Bulk actions (`BulkActionBar`)

- [ ] Selection uses a checkbox column with a "Select all on this page" checkbox labelled with the count. Selection never extends to rows that are not loaded.
- [ ] The bar announces "{n} selected" (live region) and offers only actions valid for **every** selected row and allowed for the user.
- [ ] Bulk destructive actions confirm with the count and the action ("Archive 4 photos").
- [ ] Bulk operations are sent one request per record with its own ETag and Idempotency-Key where required. The result lists successes and failures by record, never a single "done". Failed rows stay selected.
- [ ] Phase 4 bulk actions: archive media (G-1). Any other bulk action needs a wireframe update first.

## 6. Loading states

- [ ] The first load shows skeleton rows or blocks shaped like the content, with `aria-busy="true"` on the region. Text is never shown as "Loading…" alone for more than one second.
- [ ] Refreshing keeps the old content visible with a thin progress bar, so the page does not jump.
- [ ] Buttons that submit show a busy state, are disabled while busy, and keep their label ("Saving…" announced politely).
- [ ] Dashboard panels load independently; one slow or failed panel never blocks another.
- [ ] Media in processing shows "Processing" with text, not only a spinner. Upload progress is announced at 25% steps and at completion.
- [ ] Route changes show the shell immediately; data loads inside it.
- [ ] Loading indicators respect `prefers-reduced-motion` (no spinning; a static indicator with text).

## 7. Error and empty states (`ProblemMapper`, `EmptyState`)

- [ ] Every API error is an RFC 9457 problem and is mapped by `ProblemMapper`; screens never parse error text themselves. **(test)**
- [ ] **422 `validation-failed`:** the message is shown next to each field from `errors[].field`, plus a summary at the top with links to the fields. Focus moves to the summary and entered values are kept. **(test)**
- [ ] **422 `business-rule-violated` and `publish-blocked`:** a specific explanation, with blockers listed in the checklist they belong to.
- [ ] **409:** says what conflicts, and links to the conflicting record when the problem names one.
- [ ] **412:** the conflict dialog offers "Reload" or "Re-apply my changes".
- [ ] **428:** must never reach users (every edit sends If-Match); if it does, it is treated as a programming error and logged.
- [ ] **403:** "You don't have permission to …". This normally cannot happen because the action is hidden; when it does (a role changed meanwhile), the screen refreshes its context.
- [ ] **404:** "This record doesn't exist or you don't have access to it." One message for both cases.
- [ ] **429:** "Too many requests. Try again in N seconds." The countdown comes from `Retry-After`, and the action is re-enabled when it ends.
- [ ] **503 `search-timeout`:** "This search covers too much. Zoom in or add filters."
- [ ] **503 `geocoding-unavailable`:** pin-only mode with an explanation; nothing else breaks.
- [ ] **401 or session expired:** a sign-in prompt; the unsaved form stays and is resubmitted after signing in.
- [ ] **Network failure:** "You're offline. Nothing was saved." Writes are not queued silently.
- [ ] **5xx:** "Something went wrong on our side. Nothing was saved." Shows the request ID for support.
- [ ] Errors never show stack traces, SQL or internal IDs other than the request ID.
- [ ] Empty states say why there is nothing and offer the next useful action. They never show sample data. Filtered-empty and first-use empty are different messages.

## 8. Accessibility (WCAG 2.2 AA, ADR-002)

- [ ] axe reports no violations on the screen, in English and Arabic, at 1280 px and 320 px. **(test)**
- [ ] One `<h1>` per page; headings in order; landmarks: banner, navigation, main, plus complementary for side panels.
- [ ] Every control is reachable and usable by keyboard in a logical order, with a visible focus indicator (`color.focus`, 2 px, not hidden by sticky bars). **(test: keyboard paths in e2e)**
- [ ] Every form control has a visible label linked to it; required fields say "Required"; format hints are linked with `aria-describedby`; errors use `aria-invalid` and are linked to the field.
- [ ] Targets are at least 24 × 24 px (44 × 44 px on touch layouts).
- [ ] Status is never shown by colour alone: status labels, audience badges, key status, location status and map markers carry text, and markers also differ by shape.
- [ ] Every drag has a single-pointer and keyboard alternative: move buttons, "Move to position", click-to-place the pin. (WCAG 2.5.7)
- [ ] Images have meaningful alt text, or empty alt text when a caption next to them says the same.
- [ ] Status messages (saved, uploaded, loaded more, n results) use live regions without announcing every keystroke.
- [ ] Maps: the result list is always available next to the map; the map region has a name and a live summary of results; markers are focusable; the drawing tools work by keyboard.
- [ ] Text resizes to 200% and reflows at 320 px without loss of content or function.
- [ ] Animation is off under `prefers-reduced-motion`.
- [ ] Keyboard shortcuts are single-key only outside text fields and can be turned off.
- [ ] The language of the page and of foreign-language parts is set (`lang`).

## 9. RTL behaviour (Arabic)

- [ ] `<html lang dir>` comes from the user's locale; Arabic sets `dir="rtl"`. **(test)**
- [ ] Layout CSS uses logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align: start`). No `left`/`right` in layout CSS. **(test: stylelint rule)**
- [ ] Directional icons mirror (back, forward, chevrons, "move earlier/later"); logos, media controls, maps and charts do not.
- [ ] References, tag numbers, amounts, dates, coordinates, phone numbers, emails and file names are isolated with `<bdi>` or `unicode-bidi: isolate`.
- [ ] Tables mirror column order; the identifier column stays at the inline start.
- [ ] User-entered text (notes, captions, listing text) renders with `dir="auto"`. Fields for a specific language set that language's `lang` and `dir`.
- [ ] Map labels use the RTL text plugin; map controls sit at the inline end; north stays up; coordinates are not mirrored.
- [ ] Numbers use the locale's formatting (`Intl.NumberFormat`); the Gregorian calendar is used everywhere.
- [ ] Every screen is checked in Arabic with real Arabic content and with long strings, at 1280 px and 320 px. **(test)**

## 10. Permission handling

- [ ] Navigation, quick-create items, tabs and actions are built from the session context (`GET /me/context`: permissions with scopes). The UI never decides access from role names. **(test)**
- [ ] An action the user cannot take is not rendered. An action that is allowed but currently impossible (publish blockers, archive blockers, pin limit) is rendered disabled, with the reason next to it.
- [ ] Record-level scope (own, office, all) is respected by asking the API: where the UI cannot know the scope result in advance, it offers the action and handles a 403 gracefully (§7).
- [ ] Hidden routes are not linked anywhere. Opening one directly shows the 404/403 message; the API is the enforcement point.
- [ ] Sensitive actions (redact, delete now, legal hold) appear only with their permission and scope, and always confirm.
- [ ] Switching company clears all cached data, drafts and media URLs of the previous company before anything of the new company is shown. **(test)**
- [ ] Signed media URLs are used as given and never stored beyond their lifetime. Map tiles and assets come only from our own origin.
- [ ] The browser never sees access or refresh tokens: requests go through the web server with the session cookie (W-D9). Every write carries the CSRF token. **(test)**
- [ ] Read-only companies show a banner and disable every write action.
