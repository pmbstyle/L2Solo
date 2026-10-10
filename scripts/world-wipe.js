#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const HistoryStore = require('../src/HistoryStore');

const rootDir = path.resolve(__dirname, '..');
const scopes = new Set(['bots', 'players', 'all']);

function readDatabaseConfig() {
    const configuredOverride = process.env.L2NODE_CONFIG_FILE;
    const files = [
        path.join(rootDir, 'config', 'default.ini'),
        ...(process.env.L2NODE_SHARED_CONFIG_FILE ? [path.resolve(rootDir, process.env.L2NODE_SHARED_CONFIG_FILE)] : []),
        configuredOverride
            ? (path.isAbsolute(configuredOverride) ? configuredOverride : path.resolve(rootDir, configuredOverride))
            : path.join(rootDir, 'config', 'local.ini')
    ];
    let value = 'tmp/nodel2.sqlite';
    let historyValue = '';
    files.filter(fs.existsSync).forEach((file) => {
        let inDatabase = false;
        fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            const setting = () => trimmed.slice(trimmed.indexOf('=') + 1).trim();
            if (/^\[Database\]$/i.test(trimmed)) inDatabase = true;
            else if (/^\[.+\]$/.test(trimmed)) inDatabase = false;
            else if (inDatabase && /^path\s*=/.test(trimmed)) value = setting();
            else if (inDatabase && /^historyPath\s*=/.test(trimmed)) historyValue = setting();
        });
    });
    const databasePath = path.resolve(rootDir, value);
    return { databasePath, historyPath: HistoryStore.pathFor(databasePath, historyValue, rootDir) };
}

function validateScope(scope) {
    const normalized = String(scope || '').trim().toLowerCase();
    if (!scopes.has(normalized)) throw new Error('Scope must be bots, players, or all.');
    return normalized;
}

function targetClause(scope) {
    switch (validateScope(scope)) {
    case 'bots': return { sql: "username LIKE 'bot\\_%' ESCAPE '\\'", params: [] };
    case 'players': return { sql: "username NOT LIKE 'bot\\_%' ESCAPE '\\'", params: [] };
    default: return { sql: '1 = 1', params: [] };
    }
}

function previewWithConnection(db, scope) {
    const target = targetClause(scope);
    return {
        scope: validateScope(scope),
        characters: Number(db.prepare(`SELECT COUNT(*) AS count FROM characters WHERE ${target.sql}`).get(...target.params).count || 0),
        accounts: Number(db.prepare(`SELECT COUNT(*) AS count FROM accounts WHERE ${target.sql}`).get(...target.params).count || 0)
    };
}

function hasTable(db, table) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function wipeMeetings(db, ids, all) {
    if (!hasTable(db, 'board_trade_participants')) return;
    if (all) {
        ['board_trade_meeting_lines', 'board_trade_meetings', 'board_trade_participants']
            .forEach((table) => db.exec(`DELETE FROM ${table}`));
        return;
    }
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(', ');
    const meetings = `SELECT id FROM board_trade_meetings WHERE actorA IN (${placeholders}) OR actorB IN (${placeholders})`;
    const mixedTrade = db.prepare(`SELECT 1 FROM board_trade_meetings
        WHERE state NOT IN ('completed', 'cancelled')
        AND ((actorA IN (${placeholders}) AND actorB NOT IN (${placeholders}))
            OR (actorB IN (${placeholders}) AND actorA NOT IN (${placeholders}))) LIMIT 1`).get(...ids, ...ids, ...ids, ...ids);
    if (mixedTrade) throw new Error('Cancel active trades between bots and players before wiping one group, or wipe both groups.');
    db.prepare(`UPDATE board_trade_participants SET meetingId = NULL WHERE meetingId IN (${meetings})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM board_trade_meeting_lines WHERE meetingId IN (${meetings})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM board_trade_meetings WHERE id IN (${meetings})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM board_trade_participants WHERE characterId IN (${placeholders})`).run(...ids);
}

function wipeWithConnection(db, scope, onWiped = null) {
    const normalizedScope = validateScope(scope);
    const target = targetClause(normalizedScope);
    let preview, wiped;
    db.exec('BEGIN IMMEDIATE');
    try {
        preview = previewWithConnection(db, normalizedScope);
        const ids = db.prepare(`SELECT id FROM characters WHERE ${target.sql}`).all(...target.params).map((row) => Number(row.id)).filter(Boolean);
        let clanIds = [];
        wipeMeetings(db, ids, normalizedScope === 'all');
        if (normalizedScope === 'all') {
            // Character-owned rows use ON DELETE CASCADE, including migrated
            // interaction memory. Independent world projections need cleanup.
            for (const table of ['bot_background_parties', 'bot_raid_encounters', 'social_entities',
                'social_projection_cursors', 'clans', 'clan_crests', 'history_outbox']) {
                if (hasTable(db, table)) db.exec(`DELETE FROM ${table}`);
            }
        }
        if (ids.length) {
            const placeholders = ids.map(() => '?').join(', ');
            clanIds = db.prepare(`SELECT id FROM clans WHERE leaderId IN (${placeholders})`).all(...ids)
                .map((row) => Number(row.id)).filter(Boolean);
            if (clanIds.length) {
                const clanPlaceholders = clanIds.map(() => '?').join(', ');
                db.prepare(`UPDATE characters SET clanId = 0, clanPrivileges = 0 WHERE clanId IN (${clanPlaceholders})`).run(...clanIds);
                db.prepare(`DELETE FROM clans WHERE id IN (${clanPlaceholders})`).run(...clanIds);
            }
            db.prepare(`DELETE FROM characters WHERE id IN (${placeholders})`).run(...ids);
        }
        if (normalizedScope === 'bots') db.exec('DELETE FROM bot_background_parties');
        db.prepare(`DELETE FROM accounts WHERE ${target.sql}`).run(...target.params);
        wiped = { all: normalizedScope === 'all', ids: normalizedScope === 'all' ? [] : ids, clanIds };
        if (hasTable(db, 'history_outbox')) {
            wiped.outboxId = Number(db.prepare('INSERT INTO history_outbox(kind, payload) VALUES (?, ?)')
                .run('world_wipe', JSON.stringify(wiped)).lastInsertRowid);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    // A history failure cannot roll back an already committed world. Its
    // outbox instruction is replayed on the next history-worker start.
    try { onWiped?.(wiped); } catch (error) {
        throw new Error(`World data was wiped, but history cleanup is pending: ${error.message}`, { cause: error });
    }
    return preview;
}

function withConnection(work) {
    const { databasePath } = readDatabaseConfig();
    if (!fs.existsSync(databasePath)) throw new Error('No game database found.');
    const db = new DatabaseSync(databasePath, { timeout: 5000 });
    db.exec('PRAGMA foreign_keys = ON');
    try {
        return work(db);
    } finally {
        db.close();
    }
}

function preview(scope) { return withConnection((db) => previewWithConnection(db, scope)); }
function wipeHistory(db, wiped) {
    const { historyPath } = readDatabaseConfig();
    if (!fs.existsSync(historyPath)) return;
    const history = HistoryStore.open(historyPath);
    try {
        if (wiped.outboxId) {
            while (HistoryStore.cursor(history) < wiped.outboxId) {
                const transferred = HistoryStore.transfer(history, db);
                if (!transferred.moved && !transferred.failed) throw new Error('History reset instruction was not found.');
            }
            db.prepare('DELETE FROM history_outbox WHERE id <= ?').run(HistoryStore.cursor(history));
        } else {
            history.exec('BEGIN IMMEDIATE');
            try { HistoryStore.wipeWorldHistory(history, wiped); history.exec('COMMIT'); }
            catch (error) { history.exec('ROLLBACK'); throw error; }
        }
    } finally { history.close(); }
}
async function wipe(scope) { return withConnection((db) => wipeWithConnection(db, scope, (wiped) => wipeHistory(db, wiped))); }

module.exports = { validateScope, targetClause, previewWithConnection, wipeWithConnection,
    wipeHistoryWithConnection: HistoryStore.wipeWorldHistory, preview, wipe };

if (require.main === module) {
    const argument = process.argv.find((value) => value.startsWith('--scope='));
    wipe(argument?.slice('--scope='.length)).then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
        process.stderr.write(`World wipe failed: ${error.message || error}\n`);
        process.exitCode = 1;
    });
}
