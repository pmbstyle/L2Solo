#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const host = process.env.L2NODE_LAUNCHER_HOST || '127.0.0.1';
const port = Number(process.env.L2NODE_LAUNCHER_PORT || 8090);
const maxLogLines = 80;
const logsDir = path.join(rootDir, 'tmp', 'logs');
const latestLogPath = path.join(logsDir, 'latest-server.log');
const previousLogPath = path.join(logsDir, 'previous-server.log');
const launcherSettingsPath = process.env.L2NODE_LAUNCHER_SETTINGS_FILE || path.join(rootDir, 'tmp', 'launcher-settings.json');
const debugFlagNames = [
    'L2NODE_PACKET_TRACE'
];
const progressionPresets = new Set(['x1', 'x10', 'x50']);

const state = {
    phase: 'stopped',
    child: null,
    startedAt: null,
    lastExit: null,
    logFilePath: latestLogPath,
    progressionRate: initialProgressionRate(),
    logs: []
};

function log(message) {
    console.info(`Launcher  :: ${message}`);
}

function warn(message) {
    console.warn(`Launcher  :: ${message}`);
}

function stripAnsi(value) {
    return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
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

        section[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
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

function observerUrl() {
    const config = readConfig().WorldObserver || {};
    const observerHost = config.hostname === '0.0.0.0' ? '127.0.0.1' : (config.hostname || '127.0.0.1');
    const observerPort = Number(config.port || 8088);
    return `http://${observerHost}:${observerPort}/observer/`;
}

function launcherUrl() {
    return `http://${host}:${port}/`;
}

function normalizeProgressionRate(value) {
    const rate = String(value || 'x1').trim().toLowerCase();
    return progressionPresets.has(rate) ? rate : 'x1';
}

function readLauncherSettings() {
    try {
        if (!fs.existsSync(launcherSettingsPath)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(launcherSettingsPath, 'utf8'));
    } catch (err) {
        warn(`could not read launcher settings: ${err.message}`);
        return {};
    }
}

function writeLauncherSettings(settings) {
    try {
        fs.mkdirSync(path.dirname(launcherSettingsPath), { recursive: true });
        fs.writeFileSync(launcherSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (err) {
        warn(`could not write launcher settings: ${err.message}`);
    }
}

function initialProgressionRate() {
    if (process.env.L2NODE_PROGRESSION_RATE) {
        return normalizeProgressionRate(process.env.L2NODE_PROGRESSION_RATE);
    }

    return normalizeProgressionRate(readLauncherSettings().progressionRate);
}

function setProgressionRate(value) {
    state.progressionRate = normalizeProgressionRate(value);
    writeLauncherSettings({
        ...readLauncherSettings(),
        progressionRate: state.progressionRate
    });
    return state.progressionRate;
}

function prepareLogFile() {
    fs.mkdirSync(logsDir, { recursive: true });

    if (fs.existsSync(latestLogPath)) {
        fs.copyFileSync(latestLogPath, previousLogPath);
    }

    const header = [
        `L2Solo launcher server log`,
        `Started: ${new Date().toISOString()}`,
        `Command: ${process.execPath} scripts/run-server.js`,
        `Working directory: ${rootDir}`,
        `Debug flags: ${debugFlagSummary()}`,
        ''
    ].join('\n');

    fs.writeFileSync(latestLogPath, header, 'utf8');
    state.logFilePath = latestLogPath;
}

function debugFlagSummary() {
    const enabled = debugFlagNames
        .map((name) => `${name}=${process.env[name] ?? ''}`)
        .filter((entry) => !entry.endsWith('='));

    return enabled.length > 0 ? enabled.join(', ') : 'none';
}

function appendLogFile(source, line) {
    try {
        fs.mkdirSync(logsDir, { recursive: true });
        fs.appendFileSync(latestLogPath, `[${new Date().toISOString()}] [${source}] ${stripAnsi(line)}\n`, 'utf8');
    } catch (err) {
        warn(`could not write server log: ${err.message}`);
    }
}

function appendLog(source, chunk) {
    String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .forEach((line) => {
            appendLogFile(source, line);

            if (line.includes('GameServer :: successful init')) {
                state.phase = 'running';
            }

            state.logs.push({
                at: Date.now(),
                source,
                line
            });
        });

    if (state.logs.length > maxLogLines) {
        state.logs.splice(0, state.logs.length - maxLogLines);
    }
}

function publicState() {
    return {
        phase: state.phase,
        pid: state.child ? state.child.pid : null,
        startedAt: state.startedAt,
        uptimeMs: state.startedAt && state.child ? Date.now() - state.startedAt : 0,
        lastExit: state.lastExit,
        mapUrl: observerUrl(),
        launcherUrl: launcherUrl(),
        logUrl: `${launcherUrl()}api/log`,
        logFilePath: state.logFilePath,
        progressionRate: state.progressionRate,
        progressionRates: Array.from(progressionPresets),
        logs: state.logs.slice(-40)
    };
}

function startServer({ progressionRate } = {}) {
    if (state.child) {
        return publicState();
    }

    setProgressionRate(progressionRate || state.progressionRate);
    state.phase = 'starting';
    state.startedAt = Date.now();
    state.lastExit = null;
    state.logs = [];
    prepareLogFile();

    const child = spawn(process.execPath, [path.join('scripts', 'run-server.js')], {
        cwd: rootDir,
        env: {
            ...process.env,
            L2NODE_PROGRESSION_RATE: state.progressionRate
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    state.child = child;
    appendLog('launcher', `starting server process ${child.pid}`);

    child.stdout.on('data', (chunk) => appendLog('stdout', chunk));
    child.stderr.on('data', (chunk) => appendLog('stderr', chunk));
    child.on('error', (err) => {
        appendLog('launcher', `failed to start server: ${err.message}`);
        state.phase = 'stopped';
        state.child = null;
        state.lastExit = { code: 1, signal: null, at: Date.now(), error: err.message };
    });
    child.on('exit', (code, signal) => {
        appendLog('launcher', `server process exited${signal ? ` by ${signal}` : ` with code ${code || 0}`}`);
        state.child = null;
        state.phase = 'stopped';
        state.lastExit = { code: code || 0, signal: signal || null, at: Date.now() };
    });

    return publicState();
}

function stopServer() {
    if (!state.child) {
        state.phase = 'stopped';
        return publicState();
    }

    const pid = state.child.pid;
    state.phase = 'stopping';
    appendLog('launcher', `stopping server process ${pid}`);

    if (isWindows) {
        spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        state.child.kill('SIGTERM');
    }

    return publicState();
}

function sendJson(response, data, statusCode = 200) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(data));
}

function readBody(request) {
    return new Promise((resolve) => {
        let body = '';
        request.on('data', (chunk) => {
            body += chunk;
        });
        request.on('end', () => resolve(body));
    });
}

function sendHtml(response) {
    response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
    });
    response.end(`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>L2Solo Launcher</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: #151515;
            --panel: #202020;
            --panel-2: #181818;
            --text: #eeeeea;
            --muted: #aaa59a;
            --border: #36332d;
            --accent: #c6a45b;
            --green: #66c47a;
            --red: #d96b62;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: var(--bg);
            color: var(--text);
            font-family: Arial, Helvetica, sans-serif;
        }

        main {
            width: min(560px, calc(100vw - 32px));
            padding: 24px;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--panel);
            box-shadow: 0 22px 70px rgba(0, 0, 0, 0.32);
        }

        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 22px;
        }

        h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: 0;
        }

        .status {
            display: inline-flex;
            align-items: center;
            gap: 9px;
            min-width: 112px;
            justify-content: flex-end;
            color: var(--muted);
            font-size: 14px;
            text-transform: uppercase;
        }

        .dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--muted);
        }

        .running .dot {
            background: var(--green);
        }

        .starting .dot,
        .stopping .dot {
            background: var(--accent);
        }

        .stopped .dot {
            background: var(--red);
        }

        .controls {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
        }

        .rate-field {
            display: grid;
            gap: 8px;
            margin: 0 0 14px;
        }

        .rate-field label {
            color: var(--muted);
            font-size: 13px;
            font-weight: 700;
            text-transform: uppercase;
        }

        select {
            width: 100%;
            height: 42px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--panel-2);
            color: var(--text);
            font-size: 15px;
            font-weight: 700;
            padding: 0 12px;
        }

        button {
            height: 44px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--panel-2);
            color: var(--text);
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
        }

        button.primary {
            border-color: #8f7438;
            background: var(--accent);
            color: #17130b;
        }

        button:disabled {
            cursor: default;
            opacity: 0.48;
        }

        .meta {
            display: grid;
            gap: 8px;
            margin-top: 20px;
            padding: 14px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--panel-2);
            font-size: 14px;
        }

        .row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
        }

        .label {
            color: var(--muted);
        }

        .value {
            text-align: right;
            overflow-wrap: anywhere;
        }

        pre {
            min-height: 104px;
            max-height: 220px;
            margin: 16px 0 0;
            padding: 12px;
            overflow: auto;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: #101010;
            color: #d8d0c0;
            font: 12px/1.45 Consolas, Monaco, monospace;
            white-space: pre-wrap;
        }

        @media (max-width: 560px) {
            main {
                padding: 18px;
            }

            header {
                align-items: flex-start;
                flex-direction: column;
            }

            .controls {
                grid-template-columns: 1fr;
            }

            .status {
                justify-content: flex-start;
            }
        }
    </style>
</head>
<body>
    <main>
        <header>
            <h1>L2Solo Launcher</h1>
            <div id="status" class="status stopped"><span class="dot"></span><span>Stopped</span></div>
        </header>

        <section class="rate-field">
            <label for="progressionRate">Progression</label>
            <select id="progressionRate">
                <option value="x1">x1</option>
                <option value="x10">x10</option>
                <option value="x50">x50</option>
            </select>
        </section>

        <section class="controls">
            <button id="start" class="primary" type="button">Start</button>
            <button id="stop" type="button">Stop</button>
            <button id="map" type="button">Open Map</button>
            <button id="logFile" type="button">Open Log</button>
        </section>

        <section class="meta">
            <div class="row"><span class="label">Server</span><span id="server" class="value">Stopped</span></div>
            <div class="row"><span class="label">Progression</span><span id="progression" class="value">x1</span></div>
            <div class="row"><span class="label">PID</span><span id="pid" class="value">-</span></div>
            <div class="row"><span class="label">Uptime</span><span id="uptime" class="value">-</span></div>
            <div class="row"><span class="label">Log</span><span id="logPath" class="value">-</span></div>
        </section>

        <pre id="log">Launcher ready.</pre>
    </main>

    <script>
        const statusEl = document.getElementById('status');
        const statusText = statusEl.querySelector('span:last-child');
        const serverEl = document.getElementById('server');
        const progressionEl = document.getElementById('progression');
        const pidEl = document.getElementById('pid');
        const uptimeEl = document.getElementById('uptime');
        const logPathEl = document.getElementById('logPath');
        const logEl = document.getElementById('log');
        const startButton = document.getElementById('start');
        const stopButton = document.getElementById('stop');
        const mapButton = document.getElementById('map');
        const logFileButton = document.getElementById('logFile');
        const progressionRateSelect = document.getElementById('progressionRate');
        let mapUrl = '';
        let logUrl = '';
        let pendingProgressionRate = progressionRateSelect.value || 'x1';
        let hasPendingProgressionRate = false;

        function titleCase(value) {
            return value.charAt(0).toUpperCase() + value.slice(1);
        }

        function formatUptime(ms) {
            if (!ms) return '-';
            const totalSeconds = Math.floor(ms / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
        }

        async function request(path, options) {
            const response = await fetch(path, options);
            if (!response.ok) throw new Error(await response.text());
            return response.json();
        }

        function render(data) {
            const phase = data.phase || 'stopped';
            mapUrl = data.mapUrl;
            statusEl.className = 'status ' + phase;
            statusText.textContent = titleCase(phase);
            serverEl.textContent = titleCase(phase);
            const serverProgressionRate = data.progressionRate || 'x1';
            const locked = phase === 'starting' || phase === 'running' || phase === 'stopping';
            if (locked || !hasPendingProgressionRate) {
                pendingProgressionRate = serverProgressionRate;
                hasPendingProgressionRate = false;
                progressionRateSelect.value = serverProgressionRate;
            } else {
                progressionRateSelect.value = pendingProgressionRate;
            }
            progressionEl.textContent = progressionRateSelect.value;
            pidEl.textContent = data.pid || '-';
            uptimeEl.textContent = formatUptime(data.uptimeMs);
            logPathEl.textContent = data.logFilePath || '-';
            logUrl = data.logUrl || '';
            startButton.disabled = locked;
            stopButton.disabled = phase === 'stopped' || phase === 'stopping';
            progressionRateSelect.disabled = locked;
            logEl.textContent = data.logs && data.logs.length
                ? data.logs.map((entry) => entry.line).join('\\n')
                : 'Launcher ready.';
            logEl.scrollTop = logEl.scrollHeight;
        }

        async function refresh() {
            try {
                render(await request('/api/status'));
            } catch (err) {
                logEl.textContent = err.message;
            }
        }

        startButton.addEventListener('click', async () => {
            render(await request('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ progressionRate: progressionRateSelect.value })
            }));
        });

        progressionRateSelect.addEventListener('change', () => {
            pendingProgressionRate = progressionRateSelect.value;
            hasPendingProgressionRate = true;
            progressionEl.textContent = pendingProgressionRate;
            request('/api/progression-rate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ progressionRate: pendingProgressionRate })
            }).then((data) => {
                render(data);
            }).catch((err) => {
                logEl.textContent = err.message;
            });
        });

        stopButton.addEventListener('click', async () => {
            render(await request('/api/stop', { method: 'POST' }));
        });

        mapButton.addEventListener('click', () => {
            if (mapUrl) window.open(mapUrl, '_blank', 'noopener');
        });

        logFileButton.addEventListener('click', () => {
            if (logUrl) window.open(logUrl, '_blank', 'noopener');
        });

        refresh();
        setInterval(refresh, 1500);
    </script>
</body>
</html>`);
}

async function route(request, response) {
    const url = new URL(request.url, launcherUrl());

    if (request.method === 'GET' && url.pathname === '/') {
        sendHtml(response);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, publicState());
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/log') {
        const logPath = fs.existsSync(latestLogPath) ? latestLogPath : previousLogPath;

        if (!fs.existsSync(logPath)) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('No server log has been written yet.');
            return;
        }

        response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(logPath).pipe(response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/start') {
        const body = await readBody(request);
        let payload = {};
        try {
            payload = body ? JSON.parse(body) : {};
        } catch {
            payload = {};
        }
        sendJson(response, startServer({ progressionRate: payload.progressionRate }));
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/progression-rate') {
        const body = await readBody(request);
        let payload = {};
        try {
            payload = body ? JSON.parse(body) : {};
        } catch {
            payload = {};
        }
        setProgressionRate(payload.progressionRate);
        sendJson(response, publicState());
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/stop') {
        await readBody(request);
        sendJson(response, stopServer());
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
}

function openBrowser(url) {
    if (process.env.L2NODE_NO_BROWSER === '1') {
        return;
    }

    const command = isWindows ? 'cmd.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = isWindows ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => warn(`could not open browser: ${err.message}`));
    child.unref();
}

const server = http.createServer((request, response) => {
    route(request, response).catch((err) => {
        sendJson(response, { error: err.message }, 500);
    });
});

server.listen(port, host, () => {
    log(`ready at ${launcherUrl()}`);
    openBrowser(launcherUrl());
});

server.on('error', (err) => {
    warn(`failed: ${err.message}`);
    process.exit(1);
});

function shutdown() {
    if (state.child) {
        stopServer();
    }

    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
