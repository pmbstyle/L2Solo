#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WorldWipe = require('./world-wipe');

const rootDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const host = process.env.L2NODE_LAUNCHER_HOST || '127.0.0.1';
const port = Number(process.env.L2NODE_LAUNCHER_PORT || 8090);
const maxLogLines = 80;
const launcherName = process.env.L2NODE_LAUNCHER_NAME || 'L2Solo Launcher';
const runtimeDir = resolveRootPath(process.env.L2NODE_RUNTIME_DIR || 'tmp');
const logsDir = resolveRootPath(process.env.L2NODE_LOG_DIR || path.relative(rootDir, path.join(runtimeDir, 'logs')));
const latestLogPath = path.join(logsDir, 'latest-server.log');
const previousLogPath = path.join(logsDir, 'previous-server.log');
const launcherSettingsPath = resolveRootPath(process.env.L2NODE_LAUNCHER_SETTINGS_FILE || path.relative(rootDir, path.join(runtimeDir, 'launcher-settings.json')));
const debugFlagNames = [
    'L2NODE_PACKET_TRACE'
];
const progressionPresets = new Set(['x1', 'x10', 'x50']);
const reasoningEfforts = new Set(['off', 'low', 'medium', 'high']);
const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
const llmTestTimeoutMs = 30000;

const state = {
    phase: 'stopped',
    child: null,
    startedAt: null,
    lastExit: null,
    logFilePath: latestLogPath,
    progressionRate: initialProgressionRate(),
    lastWipe: null,
    llm: null,
    llmConfigFingerprint: null,
    logs: []
};

let llmTestPromise = null;

const wipeConfirmations = {
    bots: 'WIPE BOTS',
    players: 'WIPE PLAYERS',
    all: 'WIPE ALL'
};

function resolveRootPath(value) {
    return path.isAbsolute(String(value))
        ? String(value)
        : path.resolve(rootDir, String(value));
}

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
    const overridePath = process.env.L2NODE_CONFIG_FILE
        ? resolveRootPath(process.env.L2NODE_CONFIG_FILE)
        : null;
    const sharedPath = process.env.L2NODE_SHARED_CONFIG_FILE
        ? resolveRootPath(process.env.L2NODE_SHARED_CONFIG_FILE)
        : null;
    const localPath = overridePath ? null : path.join(rootDir, 'config', 'local.ini');
    const config = parseIni(fs.readFileSync(defaultPath, 'utf8'));

    [sharedPath, localPath, overridePath].filter(Boolean).forEach((configPath) => {
        if (fs.existsSync(configPath)) mergeConfig(config, parseIni(fs.readFileSync(configPath, 'utf8')));
    });

    return config;
}

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function llmConfig() {
    const config = readConfig();
    const customOptions = config.AI && typeof config.AI === 'object' ? config.AI : null;
    const optn = customOptions || config.OpenRouter || {};
    const legacyConfig = !customOptions;
    const apiUrl = String(
        process.env.L2NODE_AI_API_URL ||
        (legacyConfig ? process.env.OPENROUTER_API_URL : '') ||
        optn.apiUrl ||
        (legacyConfig ? openRouterUrl : '') ||
        ''
    ).trim();
    const apiKey = String(
        (legacyConfig ? process.env.OPENROUTER_API_KEY : process.env.L2NODE_AI_API_KEY) ||
        optn.apiKey ||
        ''
    );
    const model = String(
        (legacyConfig ? process.env.OPENROUTER_MODEL : process.env.L2NODE_AI_MODEL) ||
        optn.model ||
        ''
    ).trim();
    const reasoningFallback = legacyConfig ? 'low' : 'off';
    const configuredReasoningEffort = String(optn.reasoningEffort || reasoningFallback)
        .trim()
        .toLowerCase();
    const reasoningEffort = reasoningEfforts.has(configuredReasoningEffort)
        ? configuredReasoningEffort
        : reasoningFallback;
    const provider = apiUrl.replace(/\/+$/, '') === openRouterUrl.replace(/\/+$/, '')
        ? 'openrouter'
        : 'openai-compatible';

    return {
        enabled: bool(optn.enabled, false),
        apiUrl,
        apiKey,
        model,
        provider,
        temperature: number(optn.temperature, 0.35),
        reasoningEffort
    };
}

function safeEndpoint(value) {
    try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_) {
        return String(value || '');
    }
}

function llmConfigurationError(config) {
    if (!config.apiUrl) return 'AI is enabled, but apiUrl is empty.';
    try {
        const url = new URL(config.apiUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return 'AI apiUrl must use http:// or https://.';
        }
    } catch (_) {
        return 'AI apiUrl is not a valid URL.';
    }
    if (!config.model) return 'AI is enabled, but model is empty.';
    if (config.provider === 'openrouter' && !config.apiKey) {
        return 'OpenRouter is enabled, but apiKey is empty.';
    }
    return null;
}

function llmFingerprint(config) {
    return JSON.stringify([
        config.enabled,
        config.apiUrl,
        config.apiKey,
        config.model,
        config.provider,
        config.temperature,
        config.reasoningEffort
    ]);
}

function syncLlmState(config = llmConfig()) {
    const fingerprint = llmFingerprint(config);
    if (state.llmConfigFingerprint === fingerprint && state.llm) return state.llm;

    state.llmConfigFingerprint = fingerprint;
    const configurationError = config.enabled ? llmConfigurationError(config) : null;
    state.llm = {
        enabled: config.enabled,
        phase: config.enabled ? (configurationError ? 'error' : 'untested') : 'disabled',
        provider: config.provider,
        model: config.model,
        endpoint: safeEndpoint(config.apiUrl),
        message: configurationError || (config.enabled ? 'Ready to test.' : 'AI is disabled.'),
        latencyMs: null,
        checkedAt: null
    };
    return state.llm;
}

function llmErrorMessage(payload, fallback) {
    const message = payload?.error?.message || payload?.error || payload?.message || fallback;
    return String(message || 'Unknown provider error.').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function llmCompletionLimitParam(config) {
    if (config.provider !== 'openrouter') return 'max_tokens';
    if (config.model === 'openai/gpt-5.6-luna' || config.model === 'openai/gpt-oss-120b') {
        return 'max_tokens';
    }
    return 'max_completion_tokens';
}

function llmTestBody(config) {
    const body = {
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly L2SOLO_LLM_OK and nothing else.' }]
    };
    body[llmCompletionLimitParam(config)] = 128;

    if (!(config.provider === 'openrouter' && config.model === 'openai/gpt-5.6-luna')) {
        body.temperature = config.temperature;
    }
    if (config.provider === 'openrouter') {
        if (config.reasoningEffort !== 'off') {
            body.reasoning = { effort: config.reasoningEffort, exclude: true };
        }
    } else {
        body.reasoning_effort = config.reasoningEffort === 'off' ? 'none' : config.reasoningEffort;
    }

    return body;
}

async function runLlmInferenceTest() {
    if (llmTestPromise) return llmTestPromise;

    llmTestPromise = (async () => {
        const config = llmConfig();
        const llm = syncLlmState(config);
        if (!config.enabled) return llm;

        const configurationError = llmConfigurationError(config);
        if (configurationError) return llm;

        const startedAt = Date.now();
        state.llm = {
            ...llm,
            phase: 'testing',
            message: 'Testing inference…',
            latencyMs: null,
            checkedAt: null
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), llmTestTimeoutMs);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
            if (config.provider === 'openrouter') {
                headers['HTTP-Referer'] = launcherUrl();
                headers['X-OpenRouter-Title'] = 'L2Solo Launcher';
            }

            const response = await fetch(config.apiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(llmTestBody(config)),
                signal: controller.signal
            });
            const raw = await response.text();
            let payload = null;
            try {
                payload = raw ? JSON.parse(raw) : null;
            } catch (_) {
                payload = null;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${llmErrorMessage(payload, raw || response.statusText)}`);
            }

            const content = payload?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('The endpoint responded, but returned no assistant message.');
            }

            const latencyMs = Date.now() - startedAt;
            state.llm = {
                ...state.llm,
                phase: 'online',
                message: `Inference responded successfully in ${latencyMs} ms.`,
                latencyMs,
                checkedAt: Date.now()
            };
        } catch (error) {
            const timedOut = error?.name === 'AbortError';
            state.llm = {
                ...state.llm,
                phase: 'error',
                message: timedOut
                    ? `Inference timed out after ${llmTestTimeoutMs / 1000} seconds.`
                    : String(error?.message || error).slice(0, 700),
                latencyMs: Date.now() - startedAt,
                checkedAt: Date.now()
            };
        } finally {
            clearTimeout(timeout);
        }

        return state.llm;
    })();

    try {
        return await llmTestPromise;
    } finally {
        llmTestPromise = null;
    }
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
        llm: syncLlmState(),
        lastWipe: state.lastWipe,
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
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
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

    if (state.child.connected) state.child.send({ type: 'shutdown', reason: 'launcher_stop' });
    else state.child.kill('SIGTERM');
    setTimeout(() => {
        if (state.child?.pid !== pid) return;
        if (isWindows) spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else state.child.kill('SIGKILL');
    }, 20000).unref();

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
    <title>${launcherName}</title>
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

        .wipe-panel {
            margin-top: 20px;
            border: 1px solid #71413b;
            border-radius: 6px;
            background: #241a19;
            overflow: hidden;
        }

        .wipe-panel summary {
            color: #efb1a8;
            cursor: pointer;
            font-size: 14px;
            font-weight: 700;
            padding: 14px;
            text-transform: uppercase;
        }

        .wipe-panel[open] summary {
            border-bottom: 1px solid #71413b;
        }

        .wipe-content {
            display: grid;
            gap: 10px;
            padding: 14px;
        }

        .wipe-panel p {
            margin: 0;
            color: var(--muted);
            font-size: 13px;
            line-height: 1.4;
        }

        input {
            width: 100%;
            height: 42px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--panel-2);
            color: var(--text);
            font-size: 14px;
            padding: 0 12px;
        }

        button.danger {
            border-color: #9c5148;
            background: #9c5148;
            color: #fff8f5;
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

        .llm-panel {
            display: grid;
            gap: 12px;
            margin-top: 16px;
            padding: 14px;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--panel-2);
        }

        .llm-panel[hidden] {
            display: none;
        }

        .llm-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .llm-header h2 {
            margin: 0;
            font-size: 15px;
            text-transform: uppercase;
        }

        .llm-status {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            color: var(--muted);
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
        }

        .llm-dot {
            width: 9px;
            height: 9px;
            border-radius: 50%;
            background: var(--muted);
        }

        .llm-status.testing .llm-dot {
            background: var(--accent);
        }

        .llm-status.online .llm-dot {
            background: var(--green);
        }

        .llm-status.error .llm-dot {
            background: var(--red);
        }

        .llm-details {
            display: grid;
            gap: 7px;
            font-size: 13px;
        }

        .llm-message {
            margin: 0;
            padding: 10px;
            border: 1px solid var(--border);
            border-radius: 5px;
            color: var(--muted);
            font-size: 13px;
            line-height: 1.4;
            overflow-wrap: anywhere;
        }

        .llm-message.online {
            border-color: #356842;
            color: #a8dfb4;
            background: #152219;
        }

        .llm-message.error {
            border-color: #71413b;
            color: #efb1a8;
            background: #241a19;
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
            <h1>${launcherName}</h1>
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

        <section id="llmPanel" class="llm-panel" hidden>
            <div class="llm-header">
                <h2>LLM inference</h2>
                <span id="llmStatus" class="llm-status untested"><span class="llm-dot"></span><span>Not tested</span></span>
            </div>
            <div class="llm-details">
                <div class="row"><span class="label">Model</span><span id="llmModel" class="value">-</span></div>
                <div class="row"><span class="label">Endpoint</span><span id="llmEndpoint" class="value">-</span></div>
            </div>
            <p id="llmMessage" class="llm-message">Ready to test.</p>
            <button id="llmTest" type="button">Test inference</button>
        </section>

        <details class="wipe-panel">
            <summary>World reset</summary>
            <div class="wipe-content">
                <p>Only available while the server is stopped. This permanently removes the selected accounts and their characters.</p>
                <select id="wipeScope">
                    <option value="bots">Bots only</option>
                    <option value="players">Players only</option>
                    <option value="all">Bots and players</option>
                </select>
                <p id="wipePrompt">Type WIPE BOTS to confirm.</p>
                <input id="wipeConfirmation" type="text" autocomplete="off" spellcheck="false" placeholder="Confirmation">
                <button id="wipe" class="danger" type="button">Permanently wipe selected data</button>
            </div>
        </details>

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
        const llmPanel = document.getElementById('llmPanel');
        const llmStatusEl = document.getElementById('llmStatus');
        const llmStatusText = llmStatusEl.querySelector('span:last-child');
        const llmModelEl = document.getElementById('llmModel');
        const llmEndpointEl = document.getElementById('llmEndpoint');
        const llmMessageEl = document.getElementById('llmMessage');
        const llmTestButton = document.getElementById('llmTest');
        const logEl = document.getElementById('log');
        const startButton = document.getElementById('start');
        const stopButton = document.getElementById('stop');
        const mapButton = document.getElementById('map');
        const logFileButton = document.getElementById('logFile');
        const progressionRateSelect = document.getElementById('progressionRate');
        const wipeScopeSelect = document.getElementById('wipeScope');
        const wipeConfirmationInput = document.getElementById('wipeConfirmation');
        const wipePromptEl = document.getElementById('wipePrompt');
        const wipeButton = document.getElementById('wipe');
        const wipeConfirmations = { bots: 'WIPE BOTS', players: 'WIPE PLAYERS', all: 'WIPE ALL' };
        let mapUrl = '';
        let logUrl = '';
        let pendingProgressionRate = progressionRateSelect.value || 'x1';
        let hasPendingProgressionRate = false;
        let logAutoScroll = true;

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

        function updateWipeControls(phase) {
            const expected = wipeConfirmations[wipeScopeSelect.value] || '';
            wipePromptEl.textContent = 'Type ' + expected + ' to confirm.';
            const stopped = phase === 'stopped';
            wipeScopeSelect.disabled = !stopped;
            wipeConfirmationInput.disabled = !stopped;
            wipeButton.disabled = !stopped || wipeConfirmationInput.value.trim() !== expected;
        }

        function isLogAtBottom() {
            return logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 6;
        }

        function renderLlm(llm) {
            const enabled = llm && llm.enabled;
            llmPanel.hidden = !enabled;
            if (!enabled) return;

            const phase = llm.phase || 'untested';
            const labels = {
                untested: 'Not tested',
                testing: 'Testing',
                online: 'Online',
                error: 'Error'
            };
            llmStatusEl.className = 'llm-status ' + phase;
            llmStatusText.textContent = labels[phase] || titleCase(phase);
            llmModelEl.textContent = llm.model || '-';
            llmEndpointEl.textContent = llm.endpoint || '-';
            llmMessageEl.className = 'llm-message ' + phase;
            llmMessageEl.textContent = llm.message || 'Ready to test.';
            llmTestButton.disabled = phase === 'testing';
            llmTestButton.textContent = phase === 'testing' ? 'Testing…' : 'Test inference';
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
            renderLlm(data.llm);
            startButton.disabled = locked;
            stopButton.disabled = phase === 'stopped' || phase === 'stopping';
            progressionRateSelect.disabled = locked;
            updateWipeControls(phase);
            logEl.textContent = data.logs && data.logs.length
                ? data.logs.map((entry) => entry.line).join('\\n')
                : 'Launcher ready.';
            if (phase === 'stopped') {
                logAutoScroll = false;
            }
            if (logAutoScroll) {
                logEl.scrollTop = logEl.scrollHeight;
            }
        }

        async function refresh() {
            try {
                render(await request('/api/status'));
            } catch (err) {
                logEl.textContent = err.message;
            }
        }

        startButton.addEventListener('click', async () => {
            logAutoScroll = true;
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

        wipeScopeSelect.addEventListener('change', () => {
            wipeConfirmationInput.value = '';
            updateWipeControls(statusEl.classList.contains('stopped') ? 'stopped' : 'running');
        });

        wipeConfirmationInput.addEventListener('input', () => {
            updateWipeControls(statusEl.classList.contains('stopped') ? 'stopped' : 'running');
        });

        wipeButton.addEventListener('click', async () => {
            const scope = wipeScopeSelect.value;
            const confirmation = wipeConfirmationInput.value.trim();
            if (!window.confirm('Permanently wipe ' + scope + '? This cannot be undone.')) return;
            try {
                const data = await request('/api/wipe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope, confirmation })
                });
                wipeConfirmationInput.value = '';
                render(data);
            } catch (err) {
                logEl.textContent = err.message;
            }
        });

        stopButton.addEventListener('click', async () => {
            logAutoScroll = false;
            render(await request('/api/stop', { method: 'POST' }));
        });

        llmTestButton.addEventListener('click', async () => {
            llmTestButton.disabled = true;
            llmTestButton.textContent = 'Testing…';
            try {
                render(await request('/api/llm/test', { method: 'POST' }));
            } catch (err) {
                llmStatusEl.className = 'llm-status error';
                llmStatusText.textContent = 'Error';
                llmMessageEl.className = 'llm-message error';
                llmMessageEl.textContent = err.message;
                llmTestButton.disabled = false;
                llmTestButton.textContent = 'Test inference';
            }
        });

        logEl.addEventListener('scroll', () => {
            logAutoScroll = isLogAtBottom();
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

    if (request.method === 'POST' && url.pathname === '/api/llm/test') {
        await readBody(request);
        await runLlmInferenceTest();
        sendJson(response, publicState());
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/wipe') {
        const body = await readBody(request);
        let payload = {};
        try {
            payload = body ? JSON.parse(body) : {};
        } catch {
            payload = {};
        }

        if (state.phase !== 'stopped' || state.child) {
            sendJson(response, { error: 'Stop the server before wiping world data.' }, 409);
            return;
        }

        let scope;
        try {
            scope = WorldWipe.validateScope(payload.scope);
        } catch (error) {
            sendJson(response, { error: error.message }, 400);
            return;
        }

        if (String(payload.confirmation || '').trim() !== wipeConfirmations[scope]) {
            sendJson(response, { error: `Type ${wipeConfirmations[scope]} to confirm this wipe.` }, 400);
            return;
        }

        const result = await WorldWipe.wipe(scope);
        state.lastWipe = { ...result, at: Date.now() };
        appendLog('launcher', `world wipe completed: scope=${scope}, characters=${result.characters}, accounts=${result.accounts}`);
        sendJson(response, publicState());
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
