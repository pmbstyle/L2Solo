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

// The world's foreign keys used to delete these history rows with their
// character or clan; the history file has no foreign keys, so the wipe does it.
function wipeHistoryWithConnection(history, { all, ids = [], clanIds = [] }) {
    if (all) {
        ['bot_life_events', 'afk_trade_events', 'clan_goal_events', 'clan_actions']
            .forEach((table) => history.exec(`DELETE FROM ${table}`));
        return;
    }
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(', ');
        history.prepare(`DELETE FROM bot_life_events WHERE characterId IN (${placeholders})`).run(...ids);
        history.prepare(`DELETE FROM afk_trade_events WHERE ownerId IN (${placeholders})`).run(...ids);
        history.prepare(`UPDATE afk_trade_events SET counterpartyId = NULL WHERE counterpartyId IN (${placeholders})`).run(...ids);
    }
    if (clanIds.length) {
        const placeholders = clanIds.map(() => '?').join(', ');
        history.prepare(`DELETE FROM clan_goal_events WHERE clanId IN (${placeholders})`).run(...clanIds);
        history.prepare(`DELETE FROM clan_actions WHERE clanId IN (${placeholders})`).run(...clanIds);
    }
}

function wipeWithConnection(db, scope, onWiped = null) {
    const normalizedScope = validateScope(scope);
    const target = targetClause(normalizedScope);
    const preview = previewWithConnection(db, normalizedScope);
    const ids = db.prepare(`SELECT id FROM characters WHERE ${target.sql}`).all(...target.params).map((row) => Number(row.id)).filter(Boolean);
    let clanIds = [];

    db.exec('BEGIN IMMEDIATE');
    try {
        if (normalizedScope === 'all') {
            [
                'bot_life_state', 'bot_goal_state', 'bot_personas', 'bot_social_memory',
                'character_recipes', 'character_quests', 'warehouse_items', 'macros',
                'shortcuts', 'skills', 'items', 'bot_background_parties', 'clan_crests', 'clans'
            ].forEach((table) => db.exec(`DELETE FROM ${table}`));
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
        db.exec('COMMIT');
        onWiped?.({ all: normalizedScope === 'all', ids, clanIds });
        return preview;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function withConnection(work) {
    const db = new DatabaseSync(readDatabaseConfig().databasePath, { timeout: 5000 });
    db.exec('PRAGMA foreign_keys = ON');
    try {
        return work(db);
    } finally {
        db.close();
    }
}

function preview(scope) { return withConnection((db) => previewWithConnection(db, scope)); }
function wipeHistory(wiped) {
    const { historyPath } = readDatabaseConfig();
    if (!fs.existsSync(historyPath)) return;
    const history = new DatabaseSync(historyPath, { timeout: 5000 });
    try { wipeHistoryWithConnection(history, wiped); } finally { history.close(); }
}
function wipe(scope) { return withConnection((db) => wipeWithConnection(db, scope, wipeHistory)); }

module.exports = { validateScope, targetClause, previewWithConnection, wipeWithConnection, wipeHistoryWithConnection, preview, wipe };

if (require.main === module) {
    const argument = process.argv.find((value) => value.startsWith('--scope='));
    wipe(argument?.slice('--scope='.length)).then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
        process.stderr.write(`World wipe failed: ${error.message || error}\n`);
        process.exitCode = 1;
    });
}
