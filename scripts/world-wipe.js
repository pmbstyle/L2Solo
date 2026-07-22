#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const mariadb = require('mariadb');

const rootDir = path.resolve(__dirname, '..');
const scopes = new Set(['bots', 'players', 'all']);

function parseIni(raw) {
    const config = {};
    let section = config;
    raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return;
        const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            section = config[sectionMatch[1]] = config[sectionMatch[1]] || {};
            return;
        }
        const separator = trimmed.indexOf('=');
        if (separator === -1) return;
        section[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });
    return config;
}

function mergeConfig(base, override) {
    Object.keys(override || {}).forEach((key) => {
        if (base[key] && override[key] && typeof base[key] === 'object' && typeof override[key] === 'object') {
            mergeConfig(base[key], override[key]);
        } else {
            base[key] = override[key];
        }
    });
    return base;
}

function readConfig() {
    const config = parseIni(fs.readFileSync(path.join(rootDir, 'config', 'default.ini'), 'utf8'));
    const localPath = path.join(rootDir, 'config', 'local.ini');
    if (fs.existsSync(localPath)) mergeConfig(config, parseIni(fs.readFileSync(localPath, 'utf8')));
    return config;
}

function validateScope(scope) {
    const normalized = String(scope || '').trim().toLowerCase();
    if (!scopes.has(normalized)) throw new Error('Scope must be bots, players, or all.');
    return normalized;
}

function targetClause(scope) {
    switch (validateScope(scope)) {
    case 'bots': return { sql: "username LIKE 'bot\\_%' ESCAPE '\\\\'", params: [] };
    case 'players': return { sql: "username NOT LIKE 'bot\\_%' ESCAPE '\\\\'", params: [] };
    default: return { sql: '1 = 1', params: [] };
    }
}

function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

async function ignoreMissingTable(operation) {
    try {
        return await operation();
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
        return null;
    }
}

async function previewWithConnection(conn, scope) {
    const target = targetClause(scope);
    const [characters] = await Promise.all([
        conn.query(`SELECT COUNT(*) AS count FROM characters WHERE ${target.sql}`, target.params),
    ]);
    const accounts = await conn.query(`SELECT COUNT(*) AS count FROM accounts WHERE ${target.sql}`, target.params);
    return {
        scope: validateScope(scope),
        characters: Number(characters[0]?.count || 0),
        accounts: Number(accounts[0]?.count || 0)
    };
}

async function wipeWithConnection(conn, scope) {
    const normalizedScope = validateScope(scope);
    const target = targetClause(normalizedScope);
    const preview = await previewWithConnection(conn, normalizedScope);
    const characters = await conn.query(`SELECT id FROM characters WHERE ${target.sql}`, target.params);
    const ids = characters.map((row) => Number(row.id)).filter(Boolean);

    await conn.beginTransaction();
    try {
        if (normalizedScope === 'all') {
            for (const table of [
                'bot_life_events', 'bot_life_state', 'bot_goal_state', 'bot_social_memory',
                'character_recipes', 'character_quests', 'warehouse_items', 'macros',
                'shortcuts', 'skills', 'items', 'bot_background_parties', 'clan_crests', 'clans'
            ]) {
                await ignoreMissingTable(() => conn.query(`DELETE FROM ${table}`));
            }
        }

        if (ids.length > 0) {
            const idList = placeholders(ids.length);
            const socialParams = [...ids, ...ids];
            if (normalizedScope !== 'all') {
                await ignoreMissingTable(() => conn.query(`DELETE FROM bot_life_events WHERE characterId IN (${idList})`, ids));
                await ignoreMissingTable(() => conn.query(`DELETE FROM bot_life_state WHERE characterId IN (${idList})`, ids));
                await ignoreMissingTable(() => conn.query(`DELETE FROM bot_goal_state WHERE characterId IN (${idList})`, ids));
                await ignoreMissingTable(() => conn.query(`DELETE FROM bot_social_memory WHERE botId IN (${idList}) OR playerId IN (${idList})`, socialParams));
                for (const table of ['character_recipes', 'character_quests', 'warehouse_items', 'macros', 'shortcuts', 'skills', 'items']) {
                    await ignoreMissingTable(() => conn.query(`DELETE FROM ${table} WHERE characterId IN (${idList})`, ids));
                }

                const clans = await ignoreMissingTable(() => conn.query(`SELECT id FROM clans WHERE leaderId IN (${idList})`, ids)) || [];
                const clanIds = clans.map((row) => Number(row.id)).filter(Boolean);
                if (clanIds.length > 0) {
                    const clanList = placeholders(clanIds.length);
                    await ignoreMissingTable(() => conn.query(`DELETE FROM clan_crests WHERE clanId IN (${clanList})`, clanIds));
                    await conn.query(`UPDATE characters SET clanId = 0, clanPrivileges = 0 WHERE clanId IN (${clanList})`, clanIds);
                    await ignoreMissingTable(() => conn.query(`DELETE FROM clans WHERE id IN (${clanList})`, clanIds));
                }
            }

            await conn.query(`DELETE FROM characters WHERE id IN (${idList})`, ids);
        }

        if (normalizedScope === 'bots') {
            await ignoreMissingTable(() => conn.query('DELETE FROM bot_background_parties'));
        }
        await conn.query(`DELETE FROM accounts WHERE ${target.sql}`, target.params);
        await conn.commit();
        return preview;
    } catch (error) {
        await conn.rollback();
        throw error;
    }
}

async function withConnection(work) {
    const config = readConfig().Database || {};
    const conn = await mariadb.createConnection({
        host: config.hostname,
        port: Number(config.port || 3306),
        user: config.user,
        password: config.password,
        database: config.databaseName
    });
    try {
        return await work(conn);
    } finally {
        await conn.end();
    }
}

function preview(scope) {
    return withConnection((conn) => previewWithConnection(conn, scope));
}

function wipe(scope) {
    return withConnection((conn) => wipeWithConnection(conn, scope));
}

module.exports = { validateScope, targetClause, previewWithConnection, wipeWithConnection, preview, wipe };

if (require.main === module) {
    const argument = process.argv.find((value) => value.startsWith('--scope='));
    const scope = argument?.slice('--scope='.length);
    wipe(scope).then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
        process.stderr.write(`World wipe failed: ${error.message || error}\n`);
        process.exitCode = 1;
    });
}
