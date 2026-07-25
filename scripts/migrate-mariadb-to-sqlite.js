#!/usr/bin/env node

// One-time data migration helper. The server itself has no MariaDB runtime
// dependency; this command only needs the old driver while importing a world.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const rootDir = path.resolve(__dirname, '..');
const TABLE_ORDER = [
    'accounts', 'characters', 'clans', 'clan_crests', 'items',
    'character_recipes', 'character_quests', 'warehouse_items', 'skills',
    'shortcuts', 'macros', 'bot_life_state', 'bot_goal_state',
    'bot_social_memory', 'bot_life_events', 'bot_background_parties'
];
const SEQUENCE_TABLES = ['characters', 'clans', 'clan_crests', 'items', 'warehouse_items', 'bot_life_events'];

function parseIni(raw = '') {
    const config = {};
    let section = config;
    raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return;
        const match = trimmed.match(/^\[([^\]]+)\]$/);
        if (match) {
            section = config[match[1]] = config[match[1]] || {};
            return;
        }
        const separator = trimmed.indexOf('=');
        if (separator < 0) return;
        section[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });
    return config;
}

function argumentsMap(argv) {
    return argv.reduce((result, value) => {
        const match = value.match(/^--([^=]+)(?:=(.*))?$/);
        if (match) result[match[1]] = match[2] ?? true;
        return result;
    }, {});
}

function configuredSqlitePath() {
    const configPath = path.join(rootDir, 'config', 'default.ini');
    const config = parseIni(fs.readFileSync(configPath, 'utf8'));
    return path.resolve(rootDir, config.Database?.path || 'tmp/nodel2.sqlite');
}

function sourceSettings(args) {
    let config = {};
    if (args['source-config']) {
        config = parseIni(fs.readFileSync(path.resolve(rootDir, args['source-config']), 'utf8')).Database || {};
    } else if (args['legacy-default-from-git']) {
        // Useful only while upgrading an existing checkout that still has the
        // MariaDB config in HEAD. It never writes those credentials to disk.
        config = parseIni(execFileSync('git', ['show', 'HEAD:config/default.ini'], { cwd: rootDir, encoding: 'utf8' })).Database || {};
    }
    const setting = (name, fallback) => args[`source-${name}`] || process.env[`L2NODE_LEGACY_DB_${name.toUpperCase()}`] || fallback;
    return {
        host: setting('host', config.hostname || config.host),
        port: Number(setting('port', config.port || 3306)),
        user: setting('user', config.user),
        password: setting('password', config.password),
        database: setting('database', config.databaseName || config.database)
    };
}

function requireMariaDb() {
    try {
        return require('mariadb');
    } catch (_) {
        throw new Error('Legacy import needs the MariaDB driver once. Run "npm install --no-save mariadb" and repeat this command. The game server does not use it.');
    }
}

function validateSettings(settings) {
    if (!settings.host || !settings.user || !settings.database) {
        throw new Error('MariaDB source is not configured. Pass --source-config=path/to/old.ini, set L2NODE_LEGACY_DB_* variables, or use --legacy-default-from-git during this checkout upgrade.');
    }
}

function sqliteTables(db) {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function targetColumns(db, table) {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
}

function normalizeValue(value) {
    if (typeof value === 'bigint') return Number(value);
    return value;
}

function sourceSelect(table) {
    const characterChildren = new Set([
        'items', 'character_recipes', 'character_quests', 'warehouse_items',
        'skills', 'shortcuts', 'macros', 'bot_life_state', 'bot_goal_state', 'bot_life_events'
    ]);
    if (characterChildren.has(table)) {
        return `SELECT source.* FROM \`${table}\` source INNER JOIN \`characters\` character_ref ON character_ref.id = source.characterId`;
    }
    if (table === 'clan_crests') {
        return 'SELECT source.* FROM `clan_crests` source INNER JOIN `clans` clan_ref ON clan_ref.id = source.clanId';
    }
    if (table === 'bot_social_memory') {
        return 'SELECT source.* FROM `bot_social_memory` source INNER JOIN `characters` player_ref ON player_ref.id = source.playerId INNER JOIN `characters` bot_ref ON bot_ref.id = source.botId';
    }
    return `SELECT * FROM \`${table}\``;
}

async function importTable(source, target, table) {
    const existing = await source.query('SHOW TABLES LIKE ?', [table]);
    if (!existing.length) return { table, rows: 0, skipped: true };
    const sourceCount = Number((await source.query(`SELECT COUNT(*) AS count FROM \`${table}\``))[0]?.count || 0);
    const rows = await source.query(sourceSelect(table));
    if (!rows.length) return { table, rows: 0 };
    const columns = targetColumns(target, table).filter((column) => Object.hasOwn(rows[0], column));
    if (!columns.length) return { table, rows: 0, skipped: true };
    const statement = target.prepare(`INSERT OR REPLACE INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    let imported = 0;
    rows.forEach((row) => {
        // Zero stacks were historical garbage from the MariaDB implementation
        // and are deliberately removed by the SQLite schema/maintenance path.
        if ((table === 'items' || table === 'warehouse_items') && Number(row.amount) <= 0) return;
        statement.run(...columns.map((column) => normalizeValue(row[column])));
        imported += 1;
    });
    return { table, rows: imported, skipped: Math.max(0, sourceCount - imported) };
}

function updateSequences(target) {
    SEQUENCE_TABLES.forEach((table) => {
        const columns = targetColumns(target, table);
        if (!columns.includes('id')) return;
        const maximum = Number(target.prepare(`SELECT MAX(id) AS id FROM "${table}"`).get()?.id || 0);
        target.prepare('INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(table, maximum);
        target.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(maximum, table);
    });
}

async function migrate({ settings, targetPath }) {
    const mariadb = requireMariaDb();
    validateSettings(settings);
    if (fs.existsSync(targetPath)) throw new Error(`Target SQLite file already exists: ${targetPath}. Choose an unused --target path; this command never overwrites a world.`);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const stagingPath = `${targetPath}.importing-${process.pid}`;
    let source;
    let target;
    let transactionOpen = false;
    try {
        source = await mariadb.createConnection(settings);
        target = new DatabaseSync(stagingPath, { timeout: 5000 });
        target.exec('PRAGMA foreign_keys = OFF;');
        target.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
        target.exec('PRAGMA foreign_keys = OFF;');
        target.exec('BEGIN IMMEDIATE;');
        transactionOpen = true;
        const available = sqliteTables(target);
        const tables = [];
        for (const table of TABLE_ORDER) {
            if (available.has(table)) tables.push(await importTable(source, target, table));
        }
        updateSequences(target);
        target.prepare('INSERT OR REPLACE INTO schema_migrations(version, appliedAt) VALUES (?, ?)').run(1, Date.now());
        target.exec('COMMIT;');
        transactionOpen = false;
        target.exec('PRAGMA foreign_keys = ON;');
        const violations = target.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`Foreign-key validation failed (${violations.length} violations).`);
        target.exec('VACUUM;');
        const integrity = target.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
            throw new Error(`SQLite integrity validation failed: ${integrity.map((row) => row.integrity_check).join('; ') || 'unknown error'}`);
        }
        target.close();
        target = null;
        await source.end();
        source = null;
        fs.renameSync(stagingPath, targetPath);
        return { targetPath, tables, rows: tables.reduce((sum, entry) => sum + entry.rows, 0) };
    } catch (error) {
        if (target && transactionOpen) {
            try { target.exec('ROLLBACK;'); } catch (_) { /* best effort cleanup */ }
        }
        if (target) target.close();
        if (source) await source.end();
        if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
        throw error;
    }
}

module.exports = { parseIni, sourceSettings, migrate };

if (require.main === module) {
    const args = argumentsMap(process.argv.slice(2));
    const targetPath = path.resolve(rootDir, args.target || configuredSqlitePath());
    migrate({ settings: sourceSettings(args), targetPath }).then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
        process.stderr.write(`MariaDB to SQLite migration failed: ${error.message || error}\n`);
        process.exitCode = 1;
    });
}
