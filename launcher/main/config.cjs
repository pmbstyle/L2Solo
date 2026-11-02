'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { settingHelp } = require('./settings-help.cjs');
const { sectionOrder, fieldVisible, fieldLayout } = require('./settings-layout.cjs');

const featured = {
    General: ['progressionPreset', 'maxLevel', 'expRate', 'spRate', 'adenaRate', 'dropChanceRate', 'spoilRate'],
    BotPopulation: ['maxPlayingPopulation', 'pvpAggression', 'knowledgeErrorsEnabled', 'coldHonestTravel'],
    AI: ['enabled', 'apiUrl', 'apiKey', 'model', 'partyRouterModel', 'maxConcurrentRequests'],
    WorldObserver: ['enabled', 'hostname', 'port'],
    GameServer: ['hostname', 'advertisedHostname', 'port']
};
const extras = {
    General: { spRate: '1', spoilRate: '1' },
    GameServer: { advertisedHostname: '' },
    AI: { enabled: 'false', apiUrl: '', apiKey: '', model: '', partyRouterModel: '', temperature: '', reasoningEffort: 'off', completionLimitParam: 'max_tokens', strictSchema: 'true', maxConcurrentRequests: '32' }
};
// Keep enum choices in the settings schema so rendering and validation agree.
const enumOptions = {
    'General.progressionPreset': ['x1', 'x10', 'x50'],
    'General.newbieRewardPolicy': ['strict', 'grant', 'always']
};
for (const section of ['AI']) {
    enumOptions[`${section}.reasoningEffort`] = ['off', 'low', 'medium', 'high'];
    enumOptions[`${section}.completionLimitParam`] = ['max_tokens', 'max_completion_tokens'];
    // https://openrouter.ai/docs/guides/routing/provider-selection
    enumOptions[`${section}.providerSort`] = ['', 'price', 'throughput', 'latency'];
}

function aiConfig(config) {
    return { ...extras.AI, ...(config.AI || { apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        completionLimitParam: 'max_completion_tokens', strictSchema: 'false', ...config.OpenRouter }) };
}

function parseIni(raw) {
    const result = Object.create(null);
    let section;
    for (const line of raw.split(/\r?\n/)) {
        const value = line.trim();
        if (!value || /^[;#]/.test(value)) continue;
        const heading = value.match(/^\[([\w]+)\]$/);
        if (heading) { section = result[heading[1]] ||= Object.create(null); continue; }
        const pair = value.match(/^(\w+)\s*=\s*(.*)$/);
        if (pair && section) section[pair[1]] = pair[2];
    }
    return result;
}

function readConfig(root) {
    const base = parseIni(fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8'));
    let local = Object.create(null);
    try { local = parseIni(fs.readFileSync(path.join(root, 'config/local.ini'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [section, values] of Object.entries(local)) Object.assign(base[section] ||= Object.create(null), values);
    return base;
}

function settings(root) {
    const config = readConfig(root);
    const comments = {};
    let commentSection = '', pendingComments = [];
    for (const line of fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (/^[;#]/.test(text)) { pendingComments.push(text.replace(/^[;#]\s?/, '')); continue; }
        const heading = text.match(/^\[(\w+)\]$/);
        if (heading) commentSection = heading[1];
        const pair = text.match(/^(\w+)\s*=/);
        if (pair && pendingComments.length) comments[`${commentSection}.${pair[1]}`] = pendingComments.join(' ').slice(0, 1200);
        pendingComments = [];
    }
    const sections = { ...config };
    sections.AI = Object.fromEntries(Object.entries(aiConfig(config)).filter(([key]) => Object.hasOwn(extras.AI, key)));
    delete sections.OpenRouter;
    delete sections.Langfuse;
    return Object.entries(sections).sort(([a], [b]) => (sectionOrder.includes(a) ? sectionOrder.indexOf(a) : 99) - (sectionOrder.includes(b) ? sectionOrder.indexOf(b) : 99)).map(([section, values]) => ({
        id: section, active: true,
        fields: Object.entries({ ...extras[section], ...values }).filter(([key]) => fieldVisible(section, key)).map(([key, value]) => ({
            key, value: String(section === 'General' && values[key] === undefined && key === 'spRate' ? values.expRate || '1'
                : section === 'General' && values[key] === undefined && key === 'spoilRate' ? values.dropChanceRate || '1' : value),
            ...settingHelp(section, key, comments[`${section}.${key}`]),
            type: enumOptions[`${section}.${key}`] ? 'select' : /^(true|false)$/i.test(String(value)) ? 'boolean' : /key|secret|password/i.test(key) ? 'password' : 'text',
            options: enumOptions[`${section}.${key}`]?.slice(),
            ...fieldLayout(section, key),
            featured: featured[section]?.includes(key) || false
        })).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    })).filter(section => section.fields.length);
}

function validate(section, key, value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error(`Invalid value for ${section}.${key}`);
    const numbers = {
        'General.maxLevel': [1, 78, true], 'General.expRate': [0.01, 10000], 'General.spRate': [0.01, 10000],
        'General.adenaRate': [0.01, 10000], 'General.dropChanceRate': [0.01, 10000], 'General.spoilRate': [0.01, 10000],
        'BotPopulation.maxPlayingPopulation': [0, 100000, true], 'BotPopulation.pvpAggression': [0, 1],
        'GameServer.maxOnline': [1, 100000, true]
    };
    const range = key === 'port' ? [1, 65535, true] : numbers[`${section}.${key}`];
    if (range && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < range[0]
        || Number(value) > range[1] || (range[2] && !Number.isInteger(Number(value))))) {
        throw new Error(`${key} must be ${range[2] ? 'a whole number' : 'a number'} between ${range[0]} and ${range[1]}.`);
    }
    if (key === 'apiUrl' && value) {
        let url;
        try { url = new URL(value); } catch { throw new Error('Enter a complete AI endpoint URL.'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AI endpoint must use HTTP or HTTPS.');
    }
}

async function saveSettings(root, changes) {
    if (!Array.isArray(changes) || changes.length > 1000) throw new Error('Invalid settings request.');
    const schema = new Map(settings(root).map(section => [section.id, new Map(section.fields.map(field => [field.key, field]))]));
    for (const change of changes) {
        const field = schema.get(change?.section)?.get(change?.key);
        if (!field) throw new Error('Unknown server setting.');
        validate(change.section, change.key, change.value);
        if (field.options && !field.options.includes(change.value)) {
            throw new Error(`Choose one of ${field.options.map(value => value || 'default').join(', ')} for ${change.key}.`);
        }
        if (field.type === 'boolean' && !['true', 'false'].includes(change.value)) throw new Error('Expected true or false.');
    }
    const config = readConfig(root);
    // Creating [AI] changes provider precedence. Carry the complete legacy
    // configuration across before applying edits, including hidden routing keys.
    const writes = changes.some(change => change.section === 'AI') && !config.AI
        ? [...new Map([...Object.entries(aiConfig(config)).map(([key, value]) => ({ section: 'AI', key, value })), ...changes]
            .map(change => [`${change.section}.${change.key}`, change])).values()]
        : changes;
    const filename = path.join(root, 'config/local.ini');
    try { if ((await fs.promises.lstat(filename)).isSymbolicLink()) throw new Error('config/local.ini must not be a symbolic link when editing settings.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let raw = '';
    try { raw = await fs.promises.readFile(filename, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lines = raw.split(/\r?\n/);
    const pending = new Map(writes.map(change => [`${change.section}.${change.key}`, change]));
    let section = '';
    // Update every duplicate assignment so a later duplicate cannot undo the edit.
    for (let index = 0; index < lines.length; index++) {
        const heading = lines[index].trim().match(/^\[(\w+)\]$/);
        if (heading) section = heading[1];
        const pair = lines[index].match(/^\s*(\w+)\s*=/);
        const change = pair && pending.get(`${section}.${pair[1]}`);
        if (change) lines[index] = `${change.key} = ${change.value}`;
    }
    for (const change of writes) {
        let active = '', found = false;
        for (const line of lines) {
            const heading = line.trim().match(/^\[(\w+)\]$/);
            if (heading) active = heading[1];
            if (active === change.section && line.match(/^\s*(\w+)\s*=/)?.[1] === change.key) found = true;
        }
        if (found) continue;
        const start = lines.findIndex(line => line.trim() === `[${change.section}]`);
        if (start < 0) lines.push('', `[${change.section}]`, `${change.key} = ${change.value}`);
        else {
            let end = start + 1;
            while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
            lines.splice(end, 0, `${change.key} = ${change.value}`);
        }
    }
    const temporary = `${filename}.launcher-${crypto.randomUUID()}.tmp`;
    try {
        await fs.promises.writeFile(temporary, `${lines.join('\n').trim()}\n`, { mode: 0o600, flag: 'wx' });
        await fs.promises.rename(temporary, filename);
    } finally { await fs.promises.rm(temporary, { force: true }); }
    return settings(root);
}

module.exports = { featured, parseIni, readConfig, settings, saveSettings };
