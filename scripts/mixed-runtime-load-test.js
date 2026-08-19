#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { appendTail } = require('./hot-bot-load-test');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'tmp', 'mixed-load-tests');

function boundedNumber(args, name, fallback, min, max) {
    const value = Number(args[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`Use --${name}=<number> from ${min} to ${max}.`);
    }
    return Math.round(value);
}

function parseArguments(argv) {
    const args = Object.fromEntries(argv
        .filter((value) => value.startsWith('--'))
        .map((value) => {
            const [key, raw = 'true'] = value.slice(2).split('=', 2);
            return [key, raw];
        }));
    const hot = boundedNumber(args, 'hot', 50, 1, 500);
    const cold = boundedNumber(args, 'cold', 120, 4, 2000);
    const durationSeconds = boundedNumber(args, 'duration', 30, 10, 1800);
    const tickMs = boundedNumber(args, 'tick', 1000, 250, 10000);
    const spreadMs = boundedNumber(args, 'spread', 100, 25, tickMs);
    const playerProbeMs = boundedNumber(args, 'player-probe', 50, 20, 1000);
    const observerProbeMs = boundedNumber(args, 'observer-probe', 1000, 250, 10000);
    const thresholds = {
        scheduleP95Ms: boundedNumber(args, 'schedule-p95', 40, 1, 5000),
        scheduleP99Ms: boundedNumber(args, 'schedule-p99', 120, 1, 10000),
        scheduleMaxMs: boundedNumber(args, 'schedule-max', 150, 1, 30000),
        handlerP95Ms: boundedNumber(args, 'handler-p95', 25, 1, 5000),
        handlerP99Ms: boundedNumber(args, 'handler-p99', 75, 1, 10000),
        observerP95Ms: boundedNumber(args, 'observer-p95', 250, 1, 30000),
        eventLoopMaxMs: boundedNumber(args, 'event-loop-max', 150, 1, 30000)
    };
    return {
        hot,
        cold,
        durationMs: durationSeconds * 1000,
        tickMs,
        spreadMs,
        playerProbeMs,
        observerProbeMs,
        thresholds
    };
}

function writeConfig(runId) {
    fs.mkdirSync(outputDir, { recursive: true });
    const databasePath = path.join(outputDir, `${runId}.sqlite`);
    const configPath = path.join(outputDir, `${runId}.ini`);
    fs.writeFileSync(configPath, [
        '[Database]',
        `path = ${path.relative(rootDir, databasePath).replace(/\\/g, '/')}`,
        '',
        '[AuthServer]',
        'port = 0',
        '',
        '[GameServer]',
        'port = 0',
        '',
        '[WorldObserver]',
        'enabled = true',
        'hostname = 127.0.0.1',
        'port = 0',
        '',
        '[BotPopulation]',
        'enabled = true'
    ].join('\n'), 'utf8');
    return { configPath, databasePath };
}

function environmentFor(settings, configPath) {
    const thresholds = settings.thresholds;
    return {
        ...process.env,
        L2NODE_CONFIG_FILE: configPath,
        L2NODE_HOT_LOAD_TEST: '1',
        L2NODE_HOT_LOAD_MODE: 'mixed',
        L2NODE_HOT_LOAD_COUNT: String(settings.hot),
        L2NODE_HOT_LOAD_DURATION_MS: String(settings.durationMs),
        L2NODE_HOT_LOAD_TICK_MS: String(settings.tickMs),
        L2NODE_HOT_LOAD_SPREAD_MS: String(settings.spreadMs),
        L2NODE_HOT_LOAD_PROVISION_TIMEOUT_MS: String(Math.max(180000, settings.hot * 700 + settings.cold * 500)),
        L2NODE_MIXED_LOAD_COLD_MIN: String(settings.cold),
        L2NODE_MIXED_PLAYER_PROBE_MS: String(settings.playerProbeMs),
        L2NODE_MIXED_OBSERVER_PROBE_MS: String(settings.observerProbeMs),
        L2NODE_MIXED_SCHEDULE_P95_MS: String(thresholds.scheduleP95Ms),
        L2NODE_MIXED_SCHEDULE_P99_MS: String(thresholds.scheduleP99Ms),
        L2NODE_MIXED_SCHEDULE_MAX_MS: String(thresholds.scheduleMaxMs),
        L2NODE_MIXED_HANDLER_P95_MS: String(thresholds.handlerP95Ms),
        L2NODE_MIXED_HANDLER_P99_MS: String(thresholds.handlerP99Ms),
        L2NODE_MIXED_OBSERVER_P95_MS: String(thresholds.observerP95Ms),
        L2NODE_MIXED_EVENT_LOOP_MAX_MS: String(thresholds.eventLoopMaxMs),
        BOT_POPULATION_ENABLED: '1',
        BOT_POPULATION_MAX_PLAYING: String(settings.cold),
        BOT_POPULATION_STARTER_BOTS_PER_RACE: String(Math.ceil(settings.cold / 4)),
        BOT_POPULATION_BATCH_SIZE: String(Math.min(100, settings.cold)),
        BOT_POPULATION_SEED_DELAY_MS: '1000',
        BOT_STATUS_LOGS: '0',
        NODEL2_DEV_CONSOLE: '0'
    };
}

function runScenario(settings) {
    const runId = `mixed-${settings.hot}h-${settings.cold}c-${Date.now()}`;
    const files = writeConfig(runId);
    const environment = environmentFor(settings, files.configPath);
    const args = ['--openssl-legacy-provider', 'src/NodeL2'];

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: rootDir,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        let errorOutput = '';
        let stdoutBuffer = '';
        let result = null;
        let parseError = null;
        const consumeLine = (line) => {
            if (line.startsWith('HotLoad') || line.startsWith('HOT_LOAD_RESULT')) {
                process.stdout.write(`${line}\n`);
            }
            if (!line.startsWith('HOT_LOAD_RESULT ')) return;
            try {
                result = JSON.parse(line.slice('HOT_LOAD_RESULT '.length));
            } catch (error) {
                parseError = error;
            }
        };
        child.stdout.on('data', (chunk) => {
            const text = String(chunk);
            output = appendTail(output, text);
            stdoutBuffer += text;
            let newlineIndex;
            while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
                consumeLine(stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, ''));
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            }
        });
        child.stderr.on('data', (chunk) => {
            errorOutput = appendTail(errorOutput, String(chunk));
            process.stderr.write(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (stdoutBuffer) consumeLine(stdoutBuffer.replace(/\r$/, ''));
            if (result) {
                resolve({ ...result, files, exitCode: code || 0 });
                return;
            }
            if (parseError) {
                reject(new Error(`mixed load emitted invalid result JSON: ${parseError.message}`));
                return;
            }
            reject(new Error(`mixed load exited ${code}: ${(errorOutput || output).slice(-2000)}`));
        });
    });
}

async function main() {
    const settings = parseArguments(process.argv.slice(2));
    const result = await runScenario(settings);
    const summaryPath = path.join(outputDir, `summary-${Date.now()}.json`);
    fs.writeFileSync(summaryPath, `${JSON.stringify({ settings, result }, null, 2)}\n`, 'utf8');
    process.stdout.write(`MIXED_LOAD_SUMMARY ${JSON.stringify({ summaryPath, result })}\n`);
    if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`Mixed runtime load test failed: ${error.stack || error}\n`);
        process.exitCode = 1;
    });
}

module.exports = { parseArguments, writeConfig, environmentFor };
