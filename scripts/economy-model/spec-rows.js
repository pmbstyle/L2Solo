'use strict';

// The rows of the economy model's specification (SPEC, beside engine.js): every line of a
// Markdown table that starts with an id in backticks is a normative row. Its
// cells are named by its table's header (the line above the |---| line), in
// lower case. Pure: text in, rows out; read by the spec test.

const ROW = /^\|\s*`([A-Z0-9_.]+)`\s*\|/;
const RULE = /^\|(\s*:?-+:?\s*\|)+$/;

function cellsOf(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

// Returns [{ id, line (1-based), cells: { <header name>: text } }]. A row
// whose cell count differs from its header's throws: a '|' inside a cell
// would shift every later cell, its status among them.
function specRows(text) {
    const lines = text.split(/\r?\n/), rows = [];
    let header = null;
    lines.forEach((line, index) => {
        if (index > 0 && RULE.test(line.trim())) {
            header = cellsOf(lines[index - 1]).map(name => name.toLowerCase());
            return;
        }
        const id = ROW.exec(line);
        if (!id) return;
        const values = cellsOf(line);
        if (!header || values.length !== header.length) throw new Error(`SPEC.md:${index + 1} row ${id[1]} has ${values.length} cells, its table ${header ? header.length : 'none'}`);
        rows.push({ id: id[1], line: index + 1, cells: Object.fromEntries(header.map((name, at) => [name, values[at]])) });
    });
    return rows;
}

module.exports = { specRows };
