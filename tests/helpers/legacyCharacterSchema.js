// Rebuilds the bootstrap schema as it looked before the beginner-shot columns
// existed, so migration tests can start from a genuinely pre-migration database
// instead of asserting against a hand-written copy that could drift.
const fs = require('node:fs');
const path = require('node:path');

const NEW_COLUMN_MARKERS = /newbie|beginner-shot eligibility|character predates the flag/;

function legacySchema() {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../database/sql/sqlite.sql'), 'utf8');
    const kept = schema.split(/\r?\n/).filter(line => !NEW_COLUMN_MARKERS.test(line));
    // The column that preceded them must lose its now-trailing comma.
    return kept.join('\n').replace('head INTEGER NOT NULL DEFAULT 0,', 'head INTEGER NOT NULL DEFAULT 0');
}

module.exports = { legacySchema };
