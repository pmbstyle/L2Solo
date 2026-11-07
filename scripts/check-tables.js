'use strict';

// `npm run check`: the committed bot tables against the files they are
// simulated by (TableFingerprint). Fails on a table whose inputs moved
// since its build, naming the table and the files, and on an input list that
// names a missing path. A table built before fingerprints
// only warns: unknown until its next rebuild.
//
// Usage: node scripts/check-tables.js [--root=<dir>]  (a tree other than this checkout: tests)
const fs = require('fs');
const path = require('path');
const TableFingerprint = require('../src/GameServer/Bot/AI/TableFingerprint');

function tableFiles(root) {
    const hunt = path.join(root, 'data', 'Bots', 'hunt');
    const files = ['data/Bots/spot-table.json'];
    if (fs.existsSync(hunt)) files.push(...fs.readdirSync(hunt).filter(name => name.endsWith('.json')).sort()
        .map(name => `data/Bots/hunt/${name}`));
    return files.filter(file => fs.existsSync(path.join(root, file)));
}

// Tables with the same verdict share one line: "a.json, b.json".
function grouped(results) {
    const groups = new Map();
    for (const result of results) {
        const key = `${result.state}|${result.kind}|${result.revision}|${result.changed.join(',')}`;
        if (!groups.has(key)) groups.set(key, { ...result, tables: [] });
        groups.get(key).tables.push(result.table);
    }
    return [...groups.values()];
}

function checkTables(root = TableFingerprint.ROOT, strict = true) {
    const errors = [], warnings = [], fresh = [];
    for (const kind of Object.keys(TableFingerprint.INPUTS)) {
        const { missing } = TableFingerprint.files(kind, root);
        if (missing.length) errors.push(`TableFingerprint (src/GameServer/Bot/AI/TableFingerprint.js) lists inputs of the ${kind} `
            + `table that do not exist: ${missing.join(', ')}. Point it at the files the generator now exercises.`);
    }
    // One hash of each input set, however many tables share it.
    const current = new Map();
    const results = [];
    for (const table of tableFiles(root)) {
        const header = JSON.parse(fs.readFileSync(path.join(root, table), 'utf8')).header || {};
        const kind = TableFingerprint.GENERATORS[header.generator] || null;
        let verdict = { state: 'unknown', changed: [] };
        if (kind && header.fingerprint) {
            if (!current.has(kind)) current.set(kind, TableFingerprint.compute(kind, root));
            verdict = TableFingerprint.compare(header.fingerprint, current.get(kind));
        }
        results.push({ table, kind, revision: header.revision ?? 'unknown', ...verdict });
    }
    for (const group of grouped(results)) {
        const tables = group.tables.join(', ');
        if (group.state === 'stale') {
            (strict ? errors : warnings).push(`Stale bot table${group.tables.length > 1 ? 's' : ''} ${tables} (built at ${group.revision}): `
                + `${group.changed.length} input file${group.changed.length > 1 ? 's' : ''} changed since: `
                + `${TableFingerprint.list(group.changed)}. Rebuild on the fork: tables/${group.kind}/$sha`
                + ', or `all` when both families are stale.');
        } else if (group.state === 'unknown') {
            warnings.push(`Bot table${group.tables.length > 1 ? 's' : ''} ${tables} (built at ${group.revision}): `
                + `${group.kind ? 'no fingerprint (an older build)' : 'no known generator in the header'}, `
                + 'staleness unknown; the next rebuild enables the check.');
        } else fresh.push(...group.tables);
    }
    return { errors, warnings, fresh };
}

function main() {
    const rootArg = process.argv.slice(2).find(arg => arg.startsWith('--root='));
    const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : TableFingerprint.ROOT;
    // A stale table fails on CI (PR checks, the full run before a PR) and with --strict; on a working copy it
    // warns, so the commits of a release are not red until its tables are rebuilt before the PR.
    const strict = process.argv.includes('--strict') || process.env.CI === 'true';
    const { errors, warnings, fresh } = checkTables(root, strict);
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    for (const error of errors) console.error(`error: ${error}`);
    if (errors.length) process.exit(1);
    console.log(`Bot tables check passed: ${fresh.length} table${fresh.length === 1 ? '' : 's'} match their inputs`
        + `${warnings.length ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}`);
}

if (require.main === module) main();

module.exports = { checkTables };
