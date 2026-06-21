#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const containerName = process.env.L2NODE_DB_CONTAINER || 'nodel2-mariadb';
const imageName = process.env.L2NODE_DB_IMAGE || 'mariadb:10.6';
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const dockerCommand = isWindows ? 'docker.exe' : 'docker';

let serverChild = null;
let shuttingDown = false;

function log(message) {
    console.info(`Startup    :: ${message}`);
}

function warn(message) {
    console.warn(`Startup    :: ${message}`);
}

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: rootDir,
        encoding: 'utf8',
        ...options
    });
}

function commandAvailable(command) {
    const result = run(command, ['--version'], { stdio: 'ignore' });
    return result.status === 0;
}

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
        if (separator === -1) {
            return;
        }

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

function ensureDependencies() {
    if (fs.existsSync(path.join(rootDir, 'node_modules'))) {
        return;
    }

    log('node_modules not found; running npm install');
    const result = run(npmCommand, ['install'], { stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function isLocalDatabase(dbConfig) {
    const hostname = String(dbConfig.hostname || '').toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost';
}

function dockerInspect(format) {
    return run(dockerCommand, ['inspect', '-f', format, containerName]);
}

function ensureDockerDatabase(dbConfig) {
    if (process.env.L2NODE_SKIP_DOCKER === '1') {
        warn('L2NODE_SKIP_DOCKER=1; assuming MariaDB is already reachable');
        return;
    }

    if (!isLocalDatabase(dbConfig)) {
        warn(`database host is ${dbConfig.hostname}; skipping local Docker bootstrap`);
        return;
    }

    if (!commandAvailable(dockerCommand)) {
        warn('Docker is not available; assuming MariaDB is already reachable');
        return;
    }

    const password = dbConfig.password || '';
    const port = String(dbConfig.port || '3306');
    const databaseName = dbConfig.databaseName || 'nodel2';
    let containerCreated = false;

    const exists = dockerInspect('{{.Name}}').status === 0;
    if (!exists) {
        log(`creating ${containerName} (${imageName}) on port ${port}`);
        const result = run(dockerCommand, [
            'run',
            '-d',
            '--name',
            containerName,
            '-p',
            `${port}:3306`,
            '-e',
            `MARIADB_ROOT_PASSWORD=${password}`,
            imageName
        ], { stdio: 'inherit' });

        if (result.status !== 0) {
            warn('could not create MariaDB container; server startup will try the configured database anyway');
            return;
        }

        containerCreated = true;
    } else {
        const running = dockerInspect('{{.State.Running}}');
        if (String(running.stdout).trim() !== 'true') {
            log(`starting ${containerName}`);
            const result = run(dockerCommand, ['start', containerName], { stdio: 'inherit' });
            if (result.status !== 0) {
                warn('could not start MariaDB container; server startup will try the configured database anyway');
                return;
            }
        }
    }

    waitForDatabase(password);

    if (containerCreated || !databaseExists(password, databaseName)) {
        importDatabase(password);
    }
}

function waitForDatabase(password) {
    const passwordArg = `-p${password}`;

    for (let attempt = 1; attempt <= 30; attempt += 1) {
        const result = run(dockerCommand, [
            'exec',
            containerName,
            'mariadb',
            '-u',
            'root',
            passwordArg,
            '-e',
            'SELECT 1;'
        ], { stdio: 'ignore' });

        if (result.status === 0) {
            return;
        }

        sleep(1000);
    }

    warn('MariaDB did not become ready in 30s; server startup will continue and report any DB error');
}

function databaseExists(password, databaseName) {
    const passwordArg = `-p${password}`;
    const result = run(dockerCommand, [
        'exec',
        containerName,
        'mariadb',
        '-u',
        'root',
        passwordArg,
        '-N',
        '-s',
        '-e',
        `SHOW DATABASES LIKE '${databaseName.replace(/'/g, "''")}';`
    ]);

    return result.status === 0 && String(result.stdout).trim() === databaseName;
}

function importDatabase(password) {
    const sqlPath = path.join(rootDir, 'database', 'sql', 'database.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const passwordArg = `-p${password}`;

    log('importing database/sql/database.sql');
    const result = run(dockerCommand, [
        'exec',
        '-i',
        containerName,
        'mariadb',
        '-u',
        'root',
        passwordArg
    ], {
        input: sql,
        stdio: ['pipe', 'inherit', 'inherit']
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function stopServer(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (!serverChild || serverChild.killed) {
        process.exit(0);
        return;
    }

    serverChild.once('exit', () => process.exit(0));
    serverChild.kill(signal || 'SIGTERM');

    setTimeout(() => {
        if (serverChild && !serverChild.killed) {
            serverChild.kill('SIGKILL');
        }
    }, 5000).unref();
}

function startServer() {
    log('starting NodeL2');
    serverChild = spawn(process.execPath, ['--openssl-legacy-provider', 'src/NodeL2'], {
        cwd: rootDir,
        stdio: 'inherit',
        env: process.env
    });

    serverChild.on('exit', (code, signal) => {
        serverChild = null;

        if (shuttingDown) {
            process.exit(0);
            return;
        }

        if (signal) {
            process.kill(process.pid, signal);
            return;
        }

        process.exit(code || 0);
    });
}

function main() {
    const config = readConfig();
    ensureDependencies();
    ensureDockerDatabase(config.Database || {});
    startServer();
}

process.on('SIGINT', () => stopServer('SIGINT'));
process.on('SIGTERM', () => stopServer('SIGTERM'));

main();
