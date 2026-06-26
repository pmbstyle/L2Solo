# Client HTML UI Kit

`HtmlKit.js` is the shared builder for custom `NpcHtml` windows.

## Rules

- Keep payloads small. Legacy clients can crash around large stress pages, so prefer short rows and paged views.
- Use links for navigation, refresh, close, and dense item actions.
- Use CH3 bitmap buttons only for short primary actions near the top of a page. The old `L2UI.DefaultButton` texture renders worse in the C4 client.
- Avoid native checkbox UI for primary controls. Redraws can jump scroll position.
- Treat the outer `Chat` window title as client-controlled for `NpcHtmlMessage`. Put the reliable title inside the page body.
- `edit`, `combobox`, and `multiedit` inputs work and can return values through `$variables` in bypass actions.
- Use client textures and icons only. Custom external images are not supported by this dialog path.

## Components

- `page(body, options)` wraps a complete centered HTML window.
- `tabs(tabs, active, commandPrefix)` builds tab navigation.
- `section(title, body)` groups dense content.
- `statusTable(rows)` and `statusRow(label, value)` build key/value status panels.
- `botCard(options)` builds compact bot list entries.
- `actionFooter(actions)` builds bottom link actions.
- `emptyState(title, message, actions)` builds safe empty pages.
- `toggle(label, enabled, command)` is the recommended state toggle pattern.
