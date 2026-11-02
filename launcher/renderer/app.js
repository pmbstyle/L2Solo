'use strict';

const api = window.launcher;
document.body.dataset.platform = api?.platform || '';
const $ = id => document.getElementById(id);
let state = { installed: false, root: null, phase: 'stopped', busy: false, logs: [], progress: { percent: 0 } };
let sections = [], selectedSection = 'Quick setup', currentView = 'home', settingsRoot = null, actionPending = false, lastError = null;
const dirty = new Map();
let renderedBackups = '';
const names = { General: 'Rates & gameplay', BotPopulation: 'Bot population', AI: 'AI',
    WorldObserver: 'World Observer', GameServer: 'Game server', AuthServer: 'Login server', Database: 'Database',
    ClanSimulation: 'Clan simulation', ClanWars: 'Clan wars', Enchant: 'Enchanting' };
const labels = { progressionPreset: 'Progression preset', expRate: 'Experience multiplier', spRate: 'Skill point multiplier',
    adenaRate: 'Adena multiplier', dropChanceRate: 'Drop multiplier', spoilRate: 'Spoil multiplier', maxLevel: 'Maximum level',
    maxPlayingPopulation: 'Maximum bot population', pvpAggression: 'PvP aggression', knowledgeErrorsEnabled: 'Bots learn from mistakes',
    coldHonestTravel: 'Realistic background travel', apiUrl: 'API endpoint', apiKey: 'API key', model: 'Model',
    partyRouterModel: 'Party routing model', maxConcurrentRequests: 'Concurrent AI requests', advertisedHostname: 'Client connection address',
    hostname: 'Listen address', port: 'Port', maxOnline: 'Maximum players', pvp: 'PvP server', enabled: 'Enabled',
    path: 'World database path', reasoningEffort: 'Reasoning effort', completionLimitParam: 'Completion limit parameter' };
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
    $('status-pill').classList.toggle('transitioning', ['starting', 'stopping'].includes(state.phase));
    document.querySelector('.server-panel').classList.toggle('running', state.phase === 'running');
    $('status-pill').lastElementChild.textContent = { stopped: 'Server offline', starting: 'Starting server', running: 'Server online', stopping: 'Saving & stopping' }[state.phase];
    $('installation-path').textContent = state.root || 'No installation folder selected';
    $('installation-path').title = state.root || '';
    $('reveal-folder').hidden = !state.root;
    $('manage-folder').textContent = state.root ? 'Change folder' : 'Choose folder';
    $('manage-folder').disabled = locked || running;
    $('server-subtitle').textContent = state.developerMode ? 'Developer checkout · managed updates disabled' : state.updatePending ? 'Update installed · start to verify' : state.installed ? 'Local server · Chronicle 4' : state.root ? 'Ready to install the latest stable release.' : 'Select a server folder to get started.';
    $('server-version').textContent = state.version?.split(' ·')[0] || 'Not installed';
    $('server-version').title = state.version || '';
    $('geodata-status').textContent = state.geodata?.valid ? 'Verified · Chronicle 4' : state.installed ? 'Needs verification' : 'Not installed';
    $('geodata-status').style.color = state.geodata?.valid ? 'var(--green)' : '';
    $('server-status').textContent = state.busy ? { backup: 'Managing backup…', wipe: 'Wiping data…', settings: 'Saving settings…', files: 'Preparing files…' }[state.operation] || 'Working…' : { starting: 'Starting…', running: 'Online', stopping: 'Saving world…', stopped: ready ? 'Stopped · ready' : state.installed ? 'Setup required' : 'Waiting for setup' }[state.phase];
    $('primary-action').classList.toggle('stop', running);
    $('primary-action').classList.toggle('working', state.busy && state.operation === 'files' || ['starting', 'stopping'].includes(state.phase));
    $('primary-action').disabled = locked || state.phase === 'stopping';
    $('primary-action').firstElementChild.textContent = running ? '■' : '▶';
    $('primary-label').textContent = state.busy && state.operation === 'files' ? 'Preparing…' : running ? state.phase === 'stopping' ? 'Stopping…' : state.phase === 'starting' ? 'Starting…' : 'Stop server' : !state.root ? 'Set up server' : !state.installed ? 'Install server' : !ready ? 'Prepare server' : 'Start server';
    $('server-hint').textContent = state.connection ? `Login server: ${state.connection.address}` : 'Install or connect an existing server.';
    renderPopulation();
    $('progress-label').textContent = state.progress?.label || 'Choose a server folder';
    $('progress-percent').textContent = `${percent}%`;
    $('download-progress').value = percent;
    $('download-area').hidden = !state.busy || state.operation !== 'files';
    $('progress-indicator').classList.toggle('active', state.busy);
    $('download-detail').textContent = state.progress?.total ? `${formatBytes(state.progress.bytes)} / ${formatBytes(state.progress.total)}`
        : ready ? 'Server files and geodata verified.' : 'Preparing server files and geodata.';
    $('observer-button').disabled = state.phase !== 'running';
    $('updates-check').disabled = locked;
    $('repair-geodata').disabled = locked || running || !state.installed;
    const serverDownload = state.serverDownload?.tag === state.latest?.tag ? state.serverDownload : null;
    $('install-update').disabled = locked || !state.latest || state.latest.launcherUpdateRequired || state.developerMode || state.updatePending
        || serverDownload?.status === 'downloading' || running && (!state.latest.updateAvailable || serverDownload?.status === 'ready');
    $('install-update').textContent = serverDownload?.status === 'downloading' ? `Downloading… ${Math.floor(serverDownload.percent || 0)}%`
        : running && state.latest?.updateAvailable ? serverDownload?.status === 'ready' ? 'Stop server to apply' : 'Download server update'
            : state.latest?.updateAvailable && state.installed ? 'Update server' : state.installed ? 'Verify server files' : 'Install latest release';
    $('update-dot').hidden = !(state.latest?.updateAvailable && state.installed || ['available', 'downloaded'].includes(state.launcherUpdate?.status));
    renderLauncherUpdate(locked);
    $('channel-label').textContent = state.releaseChannel === 'preview' ? 'PREVIEW' : 'BETA';
    $('preview-notice').hidden = state.releaseChannel !== 'preview';
    if (state.latest) {
        $('update-title').textContent = !state.installed ? `${state.latest.tag} is ready to install` : state.latest.updateAvailable ? `${state.latest.tag} is available` : 'Your server is up to date';
        $('update-description').textContent = !state.installed ? 'Choose a folder to install the server.' : state.latest.updateAvailable ? `Installed: ${state.version?.split(' ·')[0]}. Your database and settings will be preserved.` : `Installed: ${state.latest.tag}. You can verify release files at any time.`;
        $('release-tag').textContent = state.latest.tag;
        $('release-notes').textContent = state.latest.notes || 'No release notes were provided.';
        $('release-date').textContent = date(state.latest.publishedAt);
        $('release-link').hidden = false;
        if (state.latest.launcherUpdateRequired) $('update-description').textContent = 'Update the launcher above before installing this server release.';
        if (state.updatePending) $('update-description').textContent = 'Start the server to verify this update. World and history snapshots will be restored if startup fails.';
        if (state.developerMode) $('update-description').textContent = 'Update this Git checkout with your development tools, or choose a separate folder for a managed installation.';
        if (serverDownload?.status === 'downloading') $('update-description').textContent = `${serverDownload.label || 'Downloading server release'}… The running world is unaffected.`;
        if (serverDownload?.status === 'ready') $('update-description').textContent = `${serverDownload.tag} is downloaded and verified. Stop the server to install it.`;
        if (serverDownload?.error) $('update-description').textContent = serverDownload.error;
    }
    if (state.updateCheckError) $('update-description').textContent = state.updateCheckError;
    $('console-status').textContent = `SERVER ${state.phase.toUpperCase()}`;
    const output = state.logs.map(entry => `${new Date(entry.at).toLocaleTimeString('en-GB')}  ${entry.line}`).join('\n');
    if (output && $('console-output').textContent !== output) {
        $('console-output').textContent = output;
        if ($('auto-scroll').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
    }
    $('save-settings').disabled = !dirty.size || locked || running;
    $('settings-notice').textContent = running ? 'Stop your server before saving settings. Your edits are kept here until you save.' : dirty.size ? `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}. Changes apply on the next server start.` : 'Changes apply the next time you start the server.';
    renderWorld(locked, running);
    renderActivity();
    renderUptime();
    if (state.launcherVersion) $('launcher-version').textContent = state.launcherVersion;
    if (state.root !== settingsRoot && sections.length) { sections = []; dirty.clear(); settingsRoot = null; }
}
function renderLauncherUpdate(locked) {
    const update = state.launcherUpdate || { status: 'idle', currentVersion: state.launcherVersion };
    $('launcher-notes-panel').hidden = !update.notes;
    $('launcher-release-notes').textContent = update.notes || '';
    const busy = ['checking', 'downloading', 'installing'].includes(update.status);
    $('launcher-update-title').textContent = update.availableVersion && ['available', 'downloading', 'downloaded', 'installing'].includes(update.status)
        ? `Launcher ${update.availableVersion} ${update.status === 'downloaded' ? 'is ready' : 'is available'}` : `L2Solo Launcher ${update.currentVersion || ''}`;
    $('launcher-update-description').textContent = update.error || ({ idle: 'Check for application updates.', checking: 'Checking GitHub Releases…',
        current: 'Your launcher is up to date.', available: update.supported ? 'Download in the background. The server can keep running.'
            : api?.platform === 'darwin' ? 'Download the DMG, then quit the launcher and replace the app. Your server folder and settings are kept.' : 'Download the installer from GitHub to update this build.',
        downloading: `Downloading… ${Math.floor(update.percent || 0)}%`, downloaded: 'Ready to install. Restarting the launcher will save and stop the server first.',
        installing: 'Stopping the server and restarting the launcher…' }[update.status] || 'Check for updates to try again.');
    $('launcher-update-action').textContent = update.status === 'downloaded' ? 'Update & restart' : ['available', 'downloading'].includes(update.status)
        ? update.supported ? update.status === 'downloading' ? 'Downloading…' : 'Download update' : api?.platform === 'darwin' ? 'Download DMG ↗' : 'Download installer ↗' : 'Check for updates';
    $('launcher-update-action').disabled = busy || locked;
    $('launcher-update-progress').hidden = update.status !== 'downloading';
    $('launcher-update-progress').value = update.percent || 0;
}
function formatBytes(bytes) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function renderUptime() {
    const seconds = state.startedAt ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) : null;
    $('server-uptime').textContent = seconds === null ? '—' : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderPopulation() {
    const population = state.population;
    $('population-area').hidden = state.phase !== 'running';
    const fresh = population && Date.now() - population.updatedAt < 10000;
    $('population-counts').textContent = fresh ? 'Bot population' : 'Waiting for population…';
    $('population-capacity').textContent = fresh ? `${population.bots.toLocaleString()} / ${population.capacity.toLocaleString()}` : '—';
    $('population-players').textContent = fresh ? `Players online: ${population.players.toLocaleString()}` : 'Players online: —';
    $('population-progress').max = fresh ? Math.max(1, population.capacity) : 1;
    $('population-progress').value = fresh ? population.bots : 0;
    $('population-progress').setAttribute('aria-valuetext', fresh ? `${population.bots} of ${population.capacity} dynamic bots` : 'Bot population unavailable');
}
function settingValueHint(value, unit) {
    const n = Number(value);
    if (!String(value).trim() || !Number.isFinite(n) || n < 0) return '';
    const number = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (unit === 'bytes') {
        const scale = n >= 1024 ** 3 ? [1024 ** 3, 'GiB'] : n >= 1024 ** 2 ? [1024 ** 2, 'MiB'] : n >= 1024 ? [1024, 'KiB'] : [1, 'B'];
        return `${number(n / scale[0])} ${scale[1]} · bytes`;
    }
    if (unit === 'ms' || unit === 'seconds') {
        const seconds = unit === 'ms' ? n / 1000 : n;
        const scale = seconds >= 86400 ? [86400, 'days'] : seconds >= 3600 ? [3600, 'h'] : seconds >= 60 ? [60, 'min'] : seconds >= 1 ? [1, 's'] : [0.001, 'ms'];
        return `${number(seconds / scale[0])} ${scale[1]} · ${unit === 'ms' ? 'milliseconds' : 'seconds'}`;
    }
    return '';
}
function renderActivity() {
    const entries = (state.logs || []).slice(-4);
    $('recent-activity').replaceChildren();
    if (!entries.length) $('recent-activity').append(element('p', 'muted', 'No server activity yet.'));
    for (const entry of entries) {
        const row = element('div', 'activity-line');
        row.append(element('time', '', new Date(entry.at).toLocaleTimeString('en-GB')), element('span', '', entry.line));
        $('recent-activity').append(row);
    }
}
function renderWorld(locked, running) {
    const world = state.world;
    const backups = world?.backups || [];
    const available = state.installed && world?.supported && !locked && !running && !state.updatePending;
    const canCreate = available && world.databaseExists;
    $('quick-backup').disabled = !canCreate;
    $('create-backup').disabled = !canCreate;
    $('quick-backup').lastChild.textContent = state.operation === 'backup' ? ' Working…' : ' Create backup';
    $('create-backup').lastChild.textContent = state.operation === 'backup' ? ' Working…' : ' Create backup';
    $('backup-name').disabled = !canCreate;
    $('backups-folder').disabled = !state.installed;
    $('refresh-backups').disabled = locked || !state.installed;
    $('backup-notice').textContent = !state.installed ? 'Select an installed server to manage its world data.'
        : world && !world.supported ? 'Update this server to enable backups and world management.'
            : running ? 'Stop the server before creating, restoring or deleting backups and wiping data.'
                : !world?.databaseExists ? 'No world database yet. Start and stop the server to create one, or restore a backup.'
                    : 'Backups include the world database and its history. Server settings are kept separately.';
    $('latest-backup').textContent = backups[0]?.name || 'No backups yet';
    $('backup-summary-detail').textContent = backups[0] ? `${date(backups[0].createdAt)} · ${formatBytes(backups[0].sizeBytes)} · ${backups.length} saved`
        : running ? 'Stop the server to create a world backup.' : 'Back up the world database and its history.';
    $('backup-count').textContent = backups.length;
    const key = JSON.stringify([state.root, backups]);
    if (renderedBackups !== key) {
        renderedBackups = key;
        $('backup-list').replaceChildren();
        if (!backups.length) $('backup-list').append(element('p', 'empty-state', 'No backups yet.'));
        for (const backup of backups) {
            const row = element('div', 'backup-row');
            const description = element('div');
            description.append(element('strong', '', backup.name), element('small', '', `${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.sizeBytes)}`));
            const actions = element('div', 'backup-actions');
            for (const action of ['load', 'delete']) {
                const button = element('button', action === 'load' ? 'quiet-button' : 'text-button', action === 'load' ? 'Restore' : 'Delete');
                button.dataset.backupAction = action;
                button.setAttribute('aria-label', `${action === 'load' ? 'Restore' : 'Delete'} ${backup.name}`);
                button.addEventListener('click', () => run(async () => {
                    const restore = action === 'load';
                    if (!await confirmAction(restore ? 'Restore backup?' : 'Delete backup?', restore
                        ? `Restore “${backup.name}”? This replaces the current world and its history. Create a backup first if you want to keep the current world.`
                        : `Permanently delete “${backup.name}”? The current world will stay unchanged.`, restore ? 'Restore backup' : 'Delete backup')) return;
                    render(await api.backup(action, { id: backup.id, confirmed: true }));
                    toast(restore ? 'World restored from backup.' : 'Backup deleted.');
                }));
                actions.append(button);
            }
            row.append(description, actions);
            $('backup-list').append(row);
        }
    }
    for (const button of document.querySelectorAll('[data-backup-action]')) button.disabled = !available;
    const phrase = `WIPE ${$('wipe-scope').value.toUpperCase()}`;
    $('wipe-phrase').textContent = phrase;
    $('wipe-confirmation').placeholder = phrase;
    $('wipe-scope').disabled = !canCreate;
    $('wipe-confirmation').disabled = !canCreate;
    $('wipe-button').disabled = !canCreate || $('wipe-confirmation').value.trim() !== phrase;
    $('wipe-button').textContent = state.operation === 'wipe' ? 'Wiping…' : 'Wipe selected data';
}
function confirmAction(title, description, label) {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = description;
    $('confirm-action').textContent = label;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
    });
}
async function createBackup(name) {
    render(await api.backup('create', { name }));
    $('backup-name').value = '';
    toast('World backup created.');
}

async function showView(view) {
    currentView = view;
    for (const node of document.querySelectorAll('.view')) node.hidden = node.id !== `view-${view}`;
    for (const node of document.querySelectorAll('.nav-item')) {
        node.classList.toggle('active', node.dataset.view === view);
        node.setAttribute('aria-current', node.dataset.view === view ? 'page' : 'false');
    }
    $('page-name').textContent = { home: 'Home', backups: 'Backups & data', settings: 'Server settings', updates: 'Updates', console: 'Console' }[view];
    document.querySelector('main').scrollTop = 0;
    if (view === 'backups' && state.installed) render(await api.world());
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
    for (const section of sections) {
        let fields = section.fields.filter(field => search ? `${section.id} ${field.key} ${humanize(field.key)} ${field.description || ''}`.toLowerCase().includes(search)
            : selectedSection === 'Quick setup' ? field.featured && ['General', 'BotPopulation', 'AI', 'WorldObserver'].includes(section.id)
                : section.id === selectedSection);
        if (!fields.length) continue;
        fields = fields.slice().sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
        const group = element('div', 'settings-group');
        group.append(element('h3', '', names[section.id] || section.id));
        const showSubgroups = new Set(fields.map(field => field.group)).size > 1;
        let previousGroup = null;
        for (const field of fields) {
            if (showSubgroups && previousGroup !== field.group) group.append(element('h4', 'settings-subheading', field.group));
            previousGroup = field.group;
            const key = `${section.id}.${field.key}`;
            const value = dirty.get(key)?.value ?? field.value;
            const row = element('div', 'field-row');
            const text = element('div', 'field-label');
            const label = element('label', '', humanize(field.key));
            label.htmlFor = `setting-${key}`;
            text.append(label);
            const description = element('small', '', field.description);
            description.id = `help-${key}`;
            text.append(description);
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
            input.setAttribute('aria-describedby', description.id);
            const hint = field.unit ? element('small', 'field-value-hint', settingValueHint(value, field.unit)) : null;
            input.addEventListener('input', () => {
                const next = field.type === 'boolean' ? String(input.checked) : input.value;
                if (hint) hint.textContent = settingValueHint(next, field.unit);
                if (next === field.value) dirty.delete(key);
                else dirty.set(key, { section: section.id, key: field.key, value: next });
                render();
            });
            if (hint) {
                const control = element('div', 'field-control');
                control.append(input, hint);
                row.append(text, control);
            } else row.append(text, input);
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
    else if (state.root && before !== state.root && !state.geodata?.valid) render(await api.repair());
}
async function checkUpdates() { render(await api.checkUpdates()); toast(state.latest?.updateAvailable ? `${state.latest.tag} is available.` : 'Update check complete.'); }
async function primaryAction() {
    if (state.phase !== 'stopped') render(await api.stop());
    else if (!state.root) await chooseFolder();
    else if (!state.installed) render(await api.install());
    else if (!state.geodata?.valid) render(await api.repair());
    else render(await api.start());
}
function renderNews(data) {
    $('news-grid').replaceChildren();
    $('news-section').hidden = data.preview || !data.articles.length;
    if (data.preview) return;
    for (const article of data.articles.slice(0, 3)) {
        const card = element('button', 'news-card');
        card.append(element('span', 'news-category', article.category), element('h4', '', article.title), element('p', '', article.excerpt));
        const bottom = element('div', 'news-card-bottom');
        bottom.append(element('span', '', date(article.publishedAt)), element('span', '', '↗'));
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
$('updates-check').addEventListener('click', () => run(checkUpdates));
$('launcher-update-action').addEventListener('click', () => run(async () => {
    const update = state.launcherUpdate;
    if (update?.status === 'downloaded') {
        if (dirty.size && !await confirmAction('Unsaved settings', 'Your unsaved settings will be discarded when the launcher restarts.', 'Continue')) return;
        if (!await confirmAction('Update launcher?', 'Save and stop the server, then install the downloaded launcher update and restart the application?', 'Update & restart')) return;
        render(await api.installLauncherUpdate());
    } else if (update?.status === 'available') {
        if (update.supported) render(await api.downloadLauncherUpdate());
        else await api.openLauncherRelease();
    } else await checkUpdates();
}));
$('install-update').addEventListener('click', () => run(async () => {
    if (state.phase !== 'stopped') { render(await api.downloadServerUpdate()); return; }
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
$('quick-backup').addEventListener('click', () => run(() => createBackup()));
$('backup-form').addEventListener('submit', event => { event.preventDefault(); if (!$('create-backup').disabled) run(() => createBackup($('backup-name').value)); });
$('refresh-backups').addEventListener('click', () => run(async () => { render(await api.world()); }));
$('backups-folder').addEventListener('click', () => run(() => api.openBackups()));
$('wipe-scope').addEventListener('change', () => { $('wipe-confirmation').value = ''; $('wipe-result').textContent = ''; render(); });
$('wipe-confirmation').addEventListener('input', () => render());
$('wipe-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('wipe-button').disabled) return;
    const scope = $('wipe-scope').value, confirmation = $('wipe-confirmation').value.trim();
    run(async () => {
        if (!await confirmAction('Wipe world data?', `Permanently remove ${scope === 'all' ? 'the entire world' : scope === 'bots' ? 'all bots and their data' : 'all players and their data'}? Your backups will be kept.`, 'Wipe data')) return;
        render(await api.wipe(scope, confirmation));
        $('wipe-confirmation').value = '';
        const result = state.world.result;
        $('wipe-result').textContent = `Removed ${result.characters} characters and ${result.accounts} accounts.`;
        toast('Selected world data wiped.');
    });
});
setInterval(() => { renderUptime(); renderPopulation(); }, 1000);
if (api) {
    api.onState(render);
    api.state().then(next => { render(next); if (next.error) error(next.error); }).catch(cause => error(cause.message));
    api.news().then(renderNews).catch(cause => error(cause.message));
} else error('Open this interface through the L2Solo desktop launcher.');
