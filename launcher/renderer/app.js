'use strict';

const api = window.launcher;
const $ = id => document.getElementById(id);
let state = { installed: false, root: null, phase: 'stopped', busy: false, logs: [], progress: { percent: 0 } };
let sections = [], selectedSection = 'Quick setup', currentView = 'home', settingsRoot = null, actionPending = false, lastError = null;
const dirty = new Map();
const names = { General: 'Rates & gameplay', BotPopulation: 'Bot population', AI: 'Custom AI provider', OpenRouter: 'OpenRouter',
    WorldObserver: 'World Observer', GameServer: 'Game server', AuthServer: 'Login server', Database: 'Database',
    ClanSimulation: 'Clan simulation', ClanWars: 'Clan wars', Enchant: 'Enchanting', Langfuse: 'AI observability' };
const labels = { progressionPreset: 'Progression preset', expRate: 'Experience multiplier', spRate: 'Skill point multiplier',
    adenaRate: 'Adena multiplier', dropChanceRate: 'Drop multiplier', spoilRate: 'Spoil multiplier', maxLevel: 'Maximum level',
    maxPlayingPopulation: 'Maximum bot population', pvpAggression: 'PvP aggression', knowledgeErrorsEnabled: 'Bots learn from mistakes',
    coldHonestTravel: 'Realistic background travel', apiUrl: 'API endpoint', apiKey: 'API key', model: 'Model',
    partyRouterModel: 'Party routing model', maxConcurrentRequests: 'Concurrent AI requests', advertisedHostname: 'Client connection address',
    hostname: 'Listen address', port: 'Port', maxOnline: 'Maximum players', pvp: 'PvP server', enabled: 'Enabled',
    path: 'World database path', reasoningEffort: 'Reasoning effort', completionLimitParam: 'Completion limit parameter' };
const descriptions = {
    progressionPreset: 'Scales XP, SP, adena, drops and spoil together. Individual multipliers apply on top.',
    maxPlayingPopulation: 'Target population for the living world. Larger worlds need more memory and CPU.',
    pvpAggression: '0 is peaceful, 0.5 is balanced, 1 is the most aggressive. Self-defense remains enabled.',
    knowledgeErrorsEnabled: 'Bots remember their own mistakes and use experience to make better decisions.',
    coldHonestTravel: 'Travel for background bots includes running, gatekeeper hops and scroll cast time.',
    apiUrl: 'Full OpenAI-compatible chat completions URL. Local HTTP endpoints are supported.',
    apiKey: 'Stored in your private config/local.ini on this computer.',
    advertisedHostname: 'IP address sent to the game client. Leave empty for automatic local/LAN detection.',
    path: 'Relative paths are resolved from your selected server folder.',
    spRate: 'Base multiplier before the progression preset. Defaults to the experience multiplier.',
    spoilRate: 'Base multiplier before the progression preset. Defaults to the drop multiplier.'
};
const humanize = key => labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase());

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function error(message) { $('error-message').textContent = String(message).replace(/^Error invoking remote method '[^']+': Error: /, ''); $('error-banner').hidden = false; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
async function run(work) {
    if (actionPending) return;
    actionPending = true;
    $('error-banner').hidden = true;
    render();
    try { return await work(); }
    catch (cause) { error(cause.message); }
    finally { actionPending = false; render(); }
}
function render(next) {
    if (next) state = { ...state, ...next };
    if (state.error && state.error !== lastError) error(state.error);
    lastError = state.error;
    const running = state.phase !== 'stopped';
    const locked = state.busy || actionPending;
    const ready = state.installed && state.geodata?.valid;
    const percent = Math.max(0, Math.min(100, Math.floor(state.progress?.percent || 0)));
    $('status-pill').classList.toggle('online', state.phase === 'running');
    $('status-pill').lastElementChild.textContent = { stopped: 'Server offline', starting: 'Starting server', running: 'Server online', stopping: 'Saving & stopping' }[state.phase];
    $('installation-path').textContent = state.root || 'No installation folder selected';
    $('installation-path').title = state.root || '';
    $('reveal-folder').hidden = !state.root;
    $('manage-folder').textContent = state.root ? 'Change folder ↗' : 'Choose folder ↗';
    $('manage-folder').disabled = locked || running;
    $('server-subtitle').textContent = state.installed ? 'Your world is ready when you are.' : state.root ? 'The latest stable release will be installed here.' : 'Give your world a place to call home.';
    $('server-version').textContent = state.version || 'Not installed';
    $('server-version').title = state.version || '';
    $('geodata-status').textContent = state.geodata?.valid ? 'Verified · Chronicle 4' : state.installed ? 'Needs verification' : 'Not installed';
    $('geodata-status').style.color = state.geodata?.valid ? 'var(--green)' : '';
    $('server-status').textContent = state.busy ? 'Preparing files' : { starting: 'Starting…', running: 'Online', stopping: 'Saving world…', stopped: ready ? 'Ready to play' : state.installed ? 'Setup required' : 'Waiting for setup' }[state.phase];
    $('primary-action').classList.toggle('stop', running);
    $('primary-action').disabled = locked || state.phase === 'stopping';
    $('primary-action').firstElementChild.textContent = running ? '■' : '▶';
    $('primary-label').textContent = locked ? 'Preparing…' : running ? state.phase === 'stopping' ? 'Stopping…' : 'Stop server' : !state.root ? 'Set up server' : !state.installed ? 'Install server' : !ready ? 'Prepare server' : 'Start server';
    $('progress-label').textContent = state.progress?.label || 'Choose a home for your world';
    $('progress-percent').textContent = `${percent}%`;
    $('download-progress').value = percent;
    $('progress-indicator').classList.toggle('active', state.busy);
    $('download-detail').textContent = state.progress?.total ? `${formatBytes(state.progress.bytes)} / ${formatBytes(state.progress.total)}`
        : ready ? 'Server files and geodata are ready. Your adventure awaits.' : 'Server files and geodata are managed for you.';
    $('observer-button').disabled = state.phase !== 'running';
    $('home-check').disabled = locked;
    $('updates-check').disabled = locked;
    $('repair-geodata').disabled = locked || running || !state.installed;
    $('install-update').disabled = locked || running || !state.latest || state.latest.launcherUpdateRequired;
    $('install-update').textContent = state.latest?.updateAvailable && state.installed ? 'Update server' : state.installed ? 'Verify server files' : 'Install latest release';
    $('update-dot').hidden = !state.latest?.updateAvailable || !state.installed;
    if (state.latest) {
        $('update-title').textContent = !state.installed ? `${state.latest.tag} is ready to install` : state.latest.updateAvailable ? `${state.latest.tag} is available` : 'Your server is up to date';
        $('update-description').textContent = !state.installed ? 'Choose a folder and start a new adventure.' : state.latest.updateAvailable ? `Installed: ${state.version}. Your world and local settings will be preserved.` : `Installed: ${state.latest.tag}. You can verify release files at any time.`;
        $('release-tag').textContent = state.latest.tag;
        $('release-notes').textContent = state.latest.notes || 'No release notes were provided.';
        $('release-date').textContent = date(state.latest.publishedAt);
        $('release-link').hidden = false;
        if (state.latest.launcherUpdateRequired) $('update-description').textContent = 'Install the matching launcher from GitHub Releases before updating this server.';
    }
    $('console-status').textContent = `SERVER ${state.phase.toUpperCase()}`;
    const output = state.logs.map(entry => `${new Date(entry.at).toLocaleTimeString('en-GB')}  ${entry.line}`).join('\n');
    if (output && $('console-output').textContent !== output) {
        $('console-output').textContent = output;
        if ($('auto-scroll').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
    }
    $('save-settings').disabled = !dirty.size || locked || running;
    $('settings-notice').textContent = running ? 'Stop your server before saving settings. Your edits are kept here until you save.' : dirty.size ? `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}. Changes apply on the next server start.` : 'Changes apply the next time you start the server.';
    if (state.launcherVersion) $('launcher-version').textContent = state.launcherVersion;
    if (state.root !== settingsRoot && sections.length) { sections = []; dirty.clear(); settingsRoot = null; }
}
function formatBytes(bytes) { return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }

async function showView(view) {
    currentView = view;
    for (const node of document.querySelectorAll('.view')) node.hidden = node.id !== `view-${view}`;
    for (const node of document.querySelectorAll('.nav-item')) node.classList.toggle('active', node.dataset.view === view);
    $('page-name').textContent = { home: 'Overview', settings: 'Server settings', updates: 'Updates', console: 'Console' }[view];
    if (view === 'settings') {
        $('settings-empty').hidden = state.installed;
        $('settings-workspace').hidden = !state.installed;
        if (state.installed && (!sections.length || settingsRoot !== state.root)) await loadSettings();
    }
    if (view === 'console' && $('auto-scroll').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
}
async function loadSettings() {
    sections = await api.settings();
    settingsRoot = state.root;
    dirty.clear();
    renderSettingsNav();
    renderFields();
    render();
}
function renderSettingsNav() {
    $('settings-nav').replaceChildren();
    for (const section of ['Quick setup', ...sections.map(section => section.id)]) {
        const button = element('button', section === selectedSection ? 'active' : '', names[section] || section);
        button.addEventListener('click', () => { selectedSection = section; $('settings-search').value = ''; renderSettingsNav(); renderFields(); });
        $('settings-nav').append(button);
    }
}
function renderFields() {
    const search = $('settings-search').value.trim().toLowerCase();
    const target = $('settings-fields');
    target.replaceChildren();
    const customAI = sections.find(section => section.id === 'AI')?.active;
    for (const section of sections) {
        let fields = section.fields.filter(field => search ? `${section.id} ${field.key} ${humanize(field.key)}`.toLowerCase().includes(search)
            : selectedSection === 'Quick setup' ? field.featured && ['General', 'BotPopulation', customAI ? 'AI' : 'OpenRouter', 'WorldObserver'].includes(section.id)
                : section.id === selectedSection);
        if (!fields.length) continue;
        fields = fields.slice().sort((a, b) => (a.order < 0 ? 999 : a.order) - (b.order < 0 ? 999 : b.order));
        const group = element('div', 'settings-group');
        group.append(element('h3', '', names[section.id] || section.id));
        for (const field of fields) {
            const key = `${section.id}.${field.key}`;
            const value = dirty.get(key)?.value ?? field.value;
            const row = element('div', 'field-row');
            const text = element('div', 'field-label');
            const label = element('label', '', humanize(field.key));
            label.htmlFor = `setting-${key}`;
            text.append(label);
            if (descriptions[field.key]) text.append(element('small', '', descriptions[field.key]));
            else if (field.key === 'enabled' && section.id === 'AI') text.append(element('small', '', 'Custom AI settings take priority over OpenRouter once configured.'));
            let input;
            if (field.type === 'select') {
                input = element('select');
                if (!field.options.includes(value)) {
                    const unknown = element('option', '', `Unsupported value: ${value || '(empty)'}`);
                    unknown.value = value;
                    unknown.disabled = true;
                    input.append(unknown);
                }
                for (const choice of field.options) {
                    const option = element('option', '', choice || 'Default (automatic)');
                    option.value = choice;
                    input.append(option);
                }
                input.value = value;
            } else {
                input = element('input');
                input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'password' ? 'password' : 'text';
                input.autocomplete = 'off';
                input.spellcheck = false;
                if (field.type === 'boolean') input.checked = value === 'true';
                else input.value = value;
            }
            input.id = `setting-${key}`;
            input.addEventListener('input', () => {
                const next = field.type === 'boolean' ? String(input.checked) : input.value;
                if (next === field.value) dirty.delete(key);
                else dirty.set(key, { section: section.id, key: field.key, value: next });
                render();
            });
            row.append(text, input);
            group.append(row);
        }
        target.append(group);
    }
    if (!target.childElementCount) target.append(element('p', 'muted', 'No settings match your search.'));
}
async function chooseFolder() {
    if (dirty.size && !window.confirm('Discard unsaved settings and choose another server folder?')) return;
    const before = state.root;
    const selected = await api.chooseFolder();
    if (selected.selectionCanceled) return;
    render(selected);
    if (before !== state.root) { sections = []; dirty.clear(); settingsRoot = null; }
    if (state.root && !state.installed) render(await api.install());
    else if (state.root && before !== state.root) {
        // Attaching an existing installation reconciles release files and geodata.
        // With no published release, the attached server remains usable.
        try { render(await api.install()); }
        catch (cause) { if (!state.geodata?.valid) render(await api.repair()); error(cause.message); }
    }
}
async function checkUpdates() { render(await api.checkUpdates()); toast(state.latest.updateAvailable ? `${state.latest.tag} is available.` : 'Your server is up to date.'); }
async function primaryAction() {
    if (state.phase !== 'stopped') render(await api.stop());
    else if (!state.root) await chooseFolder();
    else if (!state.installed) render(await api.install());
    else if (!state.geodata?.valid) render(await api.repair());
    else render(await api.start());
}
function renderNews(data) {
    $('news-grid').replaceChildren();
    $('news-preview').hidden = !data.preview;
    for (const article of data.articles.slice(0, 3)) {
        const card = element('button', 'news-card');
        card.append(element('span', 'news-category', article.category), element('h4', '', article.title), element('p', '', article.excerpt));
        const bottom = element('div', 'news-card-bottom');
        bottom.append(element('span', '', data.preview ? 'Preview story' : date(article.publishedAt)), element('span', '', '↗'));
        card.append(bottom);
        card.addEventListener('click', () => run(() => api.openLink(article.url)));
        $('news-grid').append(card);
    }
}
for (const node of document.querySelectorAll('[data-view]')) node.addEventListener('click', () => { showView(node.dataset.view).catch(cause => error(cause.message)); });
for (const node of document.querySelectorAll('[data-link]')) node.addEventListener('click', () => run(() => api.openLink(node.dataset.link)));
$('primary-action').addEventListener('click', () => run(primaryAction));
$('manage-folder').addEventListener('click', () => run(chooseFolder));
$('reveal-folder').addEventListener('click', () => run(() => api.openFolder()));
$('updates-folder').addEventListener('click', () => run(() => api.openFolder()));
$('home-check').addEventListener('click', () => run(checkUpdates));
$('updates-check').addEventListener('click', () => run(checkUpdates));
$('install-update').addEventListener('click', () => run(async () => {
    if (!state.root) await chooseFolder(); else render(await api.install());
    if (currentView === 'settings') await loadSettings();
}));
$('repair-geodata').addEventListener('click', () => run(async () => { render(await api.repair()); toast('Geodata verified. Your world is ready.'); }));
$('observer-button').addEventListener('click', () => run(() => api.openObserver()));
$('release-link').addEventListener('click', () => run(() => api.openLink(state.latest.url)));
$('settings-search').addEventListener('input', renderFields);
$('save-settings').addEventListener('click', () => run(async () => {
    sections = await api.saveSettings([...dirty.values()]);
    dirty.clear(); renderSettingsNav(); renderFields(); toast('Settings saved. They will apply on the next server start.');
}));
$('dismiss-error').addEventListener('click', () => { $('error-banner').hidden = true; });
if (api) {
    api.onState(render);
    api.state().then(next => { render(next); if (next.error) error(next.error); }).catch(cause => error(cause.message));
    api.news().then(renderNews).catch(cause => error(cause.message));
} else error('Open this interface through the L2Solo desktop launcher.');
