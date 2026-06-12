#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const mariadb = require('mariadb');

const rootDir = path.resolve(__dirname, '..');

function parseIni(raw) {
    const config = {};
    let section = config;

    raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
            return;
        }

        const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            section = config[sectionMatch[1]] = config[sectionMatch[1]] || {};
            return;
        }

        const separator = trimmed.indexOf('=');
        if (separator === -1) return;

        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();
        section[key] = value;
    });

    return config;
}

function mergeConfig(base, override) {
    Object.keys(override || {}).forEach((key) => {
        const baseValue = base[key];
        const overrideValue = override[key];

        if (
            baseValue &&
            overrideValue &&
            typeof baseValue === 'object' &&
            typeof overrideValue === 'object' &&
            !Array.isArray(baseValue) &&
            !Array.isArray(overrideValue)
        ) {
            mergeConfig(baseValue, overrideValue);
        } else {
            base[key] = overrideValue;
        }
    });

    return base;
}

function readConfig() {
    const defaultPath = path.join(rootDir, 'config', 'default.ini');
    const localPath = path.join(rootDir, 'config', 'local.ini');
    const config = parseIni(fs.readFileSync(defaultPath, 'utf8'));

    if (fs.existsSync(localPath)) {
        mergeConfig(config, parseIni(fs.readFileSync(localPath, 'utf8')));
    }

    return config;
}

function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

async function main() {
    const config = readConfig().Database || {};
    const conn = await mariadb.createConnection({
        host: config.hostname,
        port: Number(config.port || 3306),
        user: config.user,
        password: config.password,
        database: config.databaseName
    });

    try {
        const characters = await conn.query("SELECT id, name, username FROM characters WHERE username LIKE 'bot\\_%' ESCAPE '\\\\'");
        const accounts = await conn.query("SELECT username FROM accounts WHERE username LIKE 'bot\\_%' ESCAPE '\\\\'");
        const ids = characters.map((row) => row.id);

        if (ids.length > 0) {
            const idList = placeholders(ids.length);
            await conn.query(`DELETE FROM shortcuts WHERE characterId IN (${idList})`, ids);
            await conn.query(`DELETE FROM skills WHERE characterId IN (${idList})`, ids);
            await conn.query(`DELETE FROM items WHERE characterId IN (${idList})`, ids);
            await conn.query(`DELETE FROM characters WHERE id IN (${idList})`, ids);
        }

        await conn.query("DELETE FROM accounts WHERE username LIKE 'bot\\_%' ESCAPE '\\\\'");

        console.info(`Wiped ${characters.length} bot characters and ${accounts.length} bot accounts.`);
        if (characters.length > 0) {
            console.info(`Removed: ${characters.map((row) => row.name).join(', ')}`);
        }
    } finally {
        await conn.end();
    }
}

main().catch((err) => {
    console.error('Bot wipe failed:', err.message || err);
    process.exit(1);
});
