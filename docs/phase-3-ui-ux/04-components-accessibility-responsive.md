# 04 — Component Library, Accessibility and Responsive Behaviour

## 1. Component library

Build reusable components around repeated operational tasks. Components must have documented variants, states, keyboard behaviour, validation and permission expectations.

### Application shell
- `AppShell`, `PrimaryNavigation`, `CompanySwitcher`, `OfficeSwitcher`
- `GlobalSearch` with permission-filtered results
- `QuickCreateMenu` with permission-filtered actions
- `PageHeader` with title, context and primary action
- `Breadcrumbs`, `NotificationInbox`, `UserMenu`

### Data work surfaces
- `DataTable`: sort, filter, pagination, selection, column chooser, loading and empty states
- `MobileRecordList`: responsive alternative to a wide table
- `FilterBar`, `SavedViewPicker`, `ActiveFilterChips`, `DateRangeFilter`
- `StatusLabel`: text label plus optional semantic icon
- `RecordSummary`, `ActivityTimeline`, `AuditHistory`
- `Pagination` or tested virtualization for large datasets
- `BulkActionBar` with explicit affected-record count

### Forms and workflow
- `FormField`, `TextInput`, `Combobox`, `Select`, `DatePicker`, `TimePicker`
- `MoneyInput` requiring explicit currency context
- `AddressFields` configured from country/market settings
- `FileUploader` with validation and progress
- `FormSection`, `ValidationSummary`, `UnsavedChangesGuard`
- `ConfirmDialog` for consequential actions
- `WorkflowStepper` only where steps are real, ordered and meaningful
- `InlineEdit` only where auditability and validation are preserved

### Operational domain components
- `PropertySummary`, `UnitAvailability`, `OwnershipList`
- `ContactPicker`, `LeadStageControl`, `ViewingScheduler`
- `OfferHistory`, `LeaseSummary`, `LeaseTemplateSelector`
- `ChargeList`, `PaymentAllocationEditor`, `BalanceSummary`
- `MaintenancePriority`, `InspectionChecklist`
- `DocumentVersionList`, `AccessGrantSummary`

These are proposed component contracts, not claims that components exist in code. Domain components must call authorized APIs and never enforce access only in the browser.

## 2. Required component states

Every interactive component must define:
- Default
- Hover (pointer devices only; never the sole cue)
- Keyboard focus-visible
- Pressed/selected
- Disabled with reason where appropriate
- Loading/busy
- Invalid/error
- Empty/no results
- Read-only
- Permission denied where applicable

Use optimistic updates only when rollback and conflict handling are reliable. Financial allocations, lease activation, permission changes and other high-consequence operations should wait for authoritative server confirmation.

## 3. Accessibility target

Target **WCAG 2.2 Level AA**. Conformance must be tested against rendered pages and real workflows; this document is not a conformance claim.

- Semantic landmarks and heading hierarchy; one clear page-level heading.
- All functionality keyboard-operable with logical focus order.
- Visible focus indicator with sufficient contrast and no obscured focus.
- Pointer targets meet WCAG 2.2 AA minimum target-size requirements; aim for 44 × 44 CSS px on touch controls where practical.
- Text and non-text contrast meet WCAG AA; do not use color alone for status, errors or chart meaning.
- Form labels are programmatically associated; required fields and format expectations are explicit.
- Errors identify the field and explain how to fix it; preserve entered values after validation errors.
- Dialogs manage focus, have an accessible name, close predictably and return focus to the trigger.
- Tables use real header cells and appropriate scope; mobile alternatives preserve labels and relationships.
- Dynamic status updates use appropriate live regions without announcing every keystroke.
- Motion is limited, respects reduced-motion preferences and never blocks a task.
- Avoid time limits where possible; warn and allow extension where security permits.
- Authentication must support accessible password managers and paste; do not require memory puzzles.
- Screen-reader labels must describe action and context, e.g. “Open property 1042”, not repeated “Open”.
- Charts require a text summary or data table alternative.
- Locale-aware formatting must not make dates, decimal separators or currency ambiguous.

## 4. Responsive breakpoints

Use content-driven breakpoints and test actual layouts. Suggested starting points:
- Small mobile: 320–374 px
- Mobile: 375–767 px
- Tablet: 768–1023 px
- Desktop: 1024–1439 px
- Wide desktop: 1440 px and above

These are starting bands, not rigid device definitions. Components must respond to available space, not user-agent strings.

## 5. Responsive behaviour

### Desktop
- Full navigation and dense data tables.
- Filters remain visible for common workflows.
- Multi-column forms only where field grouping is meaningful.
- Detail pages may use a main content area plus a contextual side panel.
- Avoid horizontal scrolling at the page level; data tables may have a contained, labelled scroll region when necessary.

### Tablet
- Navigation collapses into a rail/drawer.
- Data tables hide lower-priority columns or become labelled record lists.
- Primary actions remain visible; secondary actions move to menus.
- Forms generally stack into one column; preserve logical reading order.
- Calendar and scheduling controls remain usable with touch.

### Mobile
- Use task-focused lists instead of compressed tables.
- One-column forms; controls fill available width.
- Sticky bottom action bars only when they do not obscure content, keyboard or screen-reader focus.
- Touch targets are comfortably sized and spaced.
- Avoid hover-only affordances and drag-only interactions.
- Photo capture, phone/email actions, notes and status updates are prioritized for field agents.
- Use pagination or incremental loading; avoid huge initial payloads.
- Show date/timezone context for appointments.
- Test portrait and landscape, zoom to 200%, and software keyboard overlap.

## 6. Performance and perceived speed

- Render page shell and primary task context before secondary panels.
- Load detail tabs on demand.
- Debounce search without making typing feel delayed; expose loading and no-results states.
- Keep list filters in URL or another shareable/restorable state where safe.
- Use server pagination/filtering for large multi-tenant datasets.
- Avoid excessive animation, auto-refresh that loses edits, and polling without operational justification.
- Provide retry for transient failures and idempotency for retried mutations.
- Never cache or reuse one tenant's sensitive response for another tenant.

## 7. Responsive acceptance checklist

- [ ] No essential action depends on hover.
- [ ] No page-level horizontal overflow at 320 px width.
- [ ] Tables have an intentional mobile alternative or contained scrolling.
- [ ] Forms retain labels, validation and logical focus order at every width.
- [ ] Dialogs fit small viewports and remain keyboard accessible.
- [ ] Touch controls are usable without precision tapping.
- [ ] Screen reader announces labels, errors, status changes and table relationships.
- [ ] Reduced motion is respected.
- [ ] Currency, date and timezone remain explicit.
- [ ] Mobile network failures do not silently discard work.
