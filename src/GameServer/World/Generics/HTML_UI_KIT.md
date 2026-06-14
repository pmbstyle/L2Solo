# C2 HTML UI Kit

`HtmlKit.js` is the shared builder for custom `NpcHtml` windows.

## Rules

- Keep payloads small. The C2 client crashed around large stress pages, so prefer short rows and paged views.
- Use links for navigation, refresh, close, and dense item actions.
- Use bitmap buttons only for short primary actions near the top of a page.
- Avoid native checkbox UI for primary controls. Redraws can jump scroll position.
- Treat the outer window title as client-controlled. Put the reliable title inside the page body.
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
