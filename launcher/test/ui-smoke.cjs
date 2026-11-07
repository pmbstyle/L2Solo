'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { prepareWorld, query } = require('./world-fixture.cjs');

module.exports = async function smoke({ window, controller, directory }) {
    window.webContents.setBackgroundThrottling(false);
    await fs.promises.mkdir(directory, { recursive: true });
    const root = path.join(directory, 'test-world');
    const put = async (name, content) => {
        const file = path.join(root, name);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, content);
    };
    const js = code => window.webContents.executeJavaScript(code, true);
    const wait = async expression => {
        const deadline = Date.now() + 10000;
        while (!await js(expression)) {
            if (Date.now() > deadline) throw new Error(`UI did not reach the expected state: ${expression}`);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    const capture = async (name, { notifications = false } = {}) => {
        window.show();
        window.focus();
        await window.webContents.insertCSS('*{animation:none!important;transition:none!important}');
        if (!notifications) await js("dismissNotification('toast'); dismissNotification('error-banner')");
        await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await new Promise(resolve => setTimeout(resolve, 150));
        await fs.promises.writeFile(path.join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    const rendererErrors = [];
    window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
    await put('package.json', JSON.stringify({ version: '0.1.0' }));
    await put('config/default.ini', await fs.promises.readFile(path.resolve(__dirname, '../../config/default.ini'), 'utf8'));
    await put('config/local.ini', '[OpenRouter]\nreasoningEffort = legacy-test-value\n[GameServer]\nadvertisedHostname = 100.92.15.42\n');
    await put('scripts/geodata-release.json', '{}');
    await put('scripts/geodata-bootstrap.js', 'module.exports = { async inspectDirectory() { return {valid:true,fileCount:141}; }, async ensureGeodata() { return {valid:true,fileCount:141}; } };');
    await put('scripts/run-server.js', "console.log('GameServer :: successful init'); process.send({type:'launcher:population',bots:1700,players:3,capacity:1700}); process.on('message',m=>{if(m.type==='shutdown'){require('fs').writeFileSync('tmp/drained','yes');process.exit(0);}});process.on('disconnect',()=>process.exit(0));");
    prepareWorld(root, controller.nodePath);
    await controller.choose(root);
    await wait("document.getElementById('primary-label').textContent === 'Start server'");
    assert.equal(await js("document.getElementById('channel-label').textContent"), controller.channel === 'preview' ? 'PREVIEW' : 'BETA');
    assert.equal(await js("document.getElementById('preview-notice').hidden"), controller.channel !== 'preview');
    assert.equal(await js("document.querySelector('.brand > div').firstChild.textContent"), 'L2Solo');
    const layoutBeforeNotifications = await js("[document.getElementById('view-home').getBoundingClientRect().top, document.querySelector('main').scrollHeight]");
    await js("error('Unable to check for updates. Please try again.'); toast('Settings saved.');");
    assert.equal(await js("getComputedStyle(document.querySelector('.notification-stack')).position"), 'fixed');
    assert.equal(await js("document.getElementById('error-banner').closest('main') === null"), true);
    assert.deepEqual(await js("[document.getElementById('view-home').getBoundingClientRect().top, document.querySelector('main').scrollHeight]"), layoutBeforeNotifications);
    await capture('notifications', { notifications: true });
    await js("document.getElementById('dismiss-error').click()");
    assert.equal(await js("document.getElementById('error-banner').hidden"), true);
    await js("error('Checking again…')");
    await new Promise(resolve => setTimeout(resolve, 3000));
    await js("error('The connection was interrupted. Please try again.'); toast('World backup created.'); window.__notificationStartedAt = performance.now();");
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(await js("!document.getElementById('error-banner').hidden && !document.getElementById('toast').hidden"), true, 'new notifications must outlive the previous timers');
    await wait("document.getElementById('error-banner').hidden && document.getElementById('toast').hidden");
    assert.equal(await js('performance.now() - window.__notificationStartedAt >= 5000'), true, 'notifications remain visible for five seconds');
    assert.deepEqual(await js("[document.getElementById('view-home').getBoundingClientRect().top, document.querySelector('main').scrollHeight]"), layoutBeforeNotifications);
    await wait("!document.getElementById('quick-backup').disabled");
    await js("document.getElementById('quick-backup').click()");
    await wait("document.querySelectorAll('.backup-row').length === 1 && !document.getElementById('quick-backup').disabled");
    await capture('home');
    assert.equal(await js("document.getElementById('observer-button').disabled"), true);
    window.setSize(960, 680);
    await capture('home-compact');
    assert.equal(await js("document.body.scrollWidth <= window.innerWidth && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth"), true);
    window.setSize(1180, 800);
    await js("document.querySelector('[data-view=backups]').click()");
    await wait("!document.getElementById('view-backups').hidden && !document.getElementById('create-backup').disabled");
    await js("document.getElementById('backup-name').value='Before weekend session';document.getElementById('create-backup').click()");
    await wait("document.querySelectorAll('.backup-row').length === 2 && !document.getElementById('create-backup').disabled");
    await capture('backups');
    await js("document.querySelector('.danger-panel').open=true;document.getElementById('wipe-confirmation').value='WIPE ALL';document.getElementById('wipe-confirmation').dispatchEvent(new Event('input'))");
    assert.equal(await js("document.getElementById('wipe-button').disabled"), true);
    await js("document.getElementById('wipe-confirmation').value='WIPE BOTS';document.getElementById('wipe-confirmation').dispatchEvent(new Event('input'));document.getElementById('wipe-button').click()");
    await wait("document.getElementById('confirm-dialog').open");
    await capture('wipe-confirmation');
    await js("document.querySelector('#confirm-dialog button[value=cancel]').click()");
    await wait("!document.getElementById('wipe-button').disabled");
    assert.equal(query(root, controller.nodePath, 'SELECT COUNT(*) n FROM characters')[0].n, 2);
    await js("document.getElementById('wipe-button').click()");
    await wait("document.getElementById('confirm-dialog').open");
    await js("document.getElementById('confirm-action').click()");
    await wait("document.getElementById('wipe-result').textContent.includes('Removed 1 characters')");
    assert.equal(query(root, controller.nodePath, 'SELECT COUNT(*) n FROM characters')[0].n, 1);
    await wait("!document.querySelector('[data-backup-action=load]').disabled");
    await js("document.querySelector('[data-backup-action=load]').click()");
    await wait("document.getElementById('confirm-dialog').open");
    await js("document.getElementById('confirm-action').click()");
    await wait("document.getElementById('toast').textContent === 'World restored from backup.' && !document.querySelector('[data-backup-action=delete]').disabled");
    assert.equal(query(root, controller.nodePath, 'SELECT COUNT(*) n FROM characters')[0].n, 2);
    await js("document.querySelector('[data-backup-action=delete]').click()");
    await wait("document.getElementById('confirm-dialog').open");
    await js("document.getElementById('confirm-action').click()");
    await wait("document.querySelectorAll('.backup-row').length === 1 && !document.getElementById('create-backup').disabled");
    await js("document.querySelector('[data-view=settings]').click()");
    await wait("document.getElementById('setting-BotPopulation.maxPlayingPopulation') !== null");
    const population = await js("document.getElementById('setting-BotPopulation.maxPlayingPopulation').value === '600' ? '601' : '600'");
    await js(`const field=document.getElementById('setting-BotPopulation.maxPlayingPopulation');field.value=${JSON.stringify(population)};field.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('save-settings').click()`);
    await wait("document.getElementById('toast').textContent.startsWith('Settings saved')");
    assert.match(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), new RegExp(`maxPlayingPopulation = ${population}`));
    assert.equal(await js("Array.from(document.querySelectorAll('#settings-nav button')).some(button => ['OpenRouter','Custom AI provider','AI observability','Langfuse'].includes(button.textContent))"), false);
    assert.equal(await js("Array.from(document.querySelectorAll('#settings-fields .field-row')).every(row => row.querySelector('.field-label small')?.textContent.length > 20)"), true);
    assert.equal(await js("document.getElementById('setting-BotPopulation.enabled') === null"), true);
    await capture('settings');
    await js("Array.from(document.querySelectorAll('#settings-nav button')).find(button => button.textContent === 'Database').click()");
    await wait("document.getElementById('setting-Database.path') !== null");
    assert.deepEqual(await js("Array.from(document.querySelectorAll('#settings-fields input')).map(input => input.id)"), ['setting-Database.path']);
    await capture('settings-database');
    await js("Array.from(document.querySelectorAll('#settings-nav button')).find(button => button.textContent === 'Bot population').click()");
    await wait("document.getElementById('setting-BotPopulation.generatedColdSeedDelayMs') !== null");
    assert.equal(await js("document.getElementById('setting-BotPopulation.generatedColdSeedDelayMs').parentElement.querySelector('.field-value-hint').textContent"), '45 s · milliseconds');
    assert.equal(await js("document.getElementById('setting-BotPopulation.enabled') === null && document.getElementById('setting-BotPopulation.developerDiagnostics') === null"), true);
    assert.deepEqual(await js("Array.from(document.querySelectorAll('#settings-fields .settings-subheading')).map(node => node.textContent)"), ['Population & seeding','Behavior & travel','Social scenes','Logging']);
    await capture('settings-bots');
    await js("document.getElementById('settings-search').value='checkpointIntervalMs';document.getElementById('settings-search').dispatchEvent(new Event('input'))");
    await wait("document.getElementById('settings-fields').textContent.includes('No settings match')");
    assert.equal(await js("document.getElementById('setting-Database.checkpointIntervalMs') === null"), true);
    await js("Array.from(document.querySelectorAll('#settings-nav button')).find(button => button.textContent === 'AI').click()");
    await wait("document.getElementById('setting-AI.reasoningEffort') !== null");
    const enumControls = await js(`(() => {
        const effort = document.getElementById('setting-AI.reasoningEffort');
        return { tag: effort.tagName, value: effort.value,
            choices: Array.from(effort.options).filter(option => !option.disabled).map(option => option.value),
            unknownDisabled: effort.selectedOptions[0].disabled,
            completion: document.getElementById('setting-AI.completionLimitParam').tagName,
            endpoint: document.getElementById('setting-AI.apiUrl').tagName };
    })()`);
    assert.deepEqual(enumControls, { tag: 'SELECT', value: 'legacy-test-value', choices: ['off', 'low', 'medium', 'high'],
        unknownDisabled: true, completion: 'SELECT', endpoint: 'INPUT' });
    await js(`(() => {
        window.previousEnumField = document.getElementById('setting-AI.reasoningEffort');
        window.previousEnumField.value = 'high';
        window.previousEnumField.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-settings').click();
    })()`);
    await wait("document.getElementById('setting-AI.reasoningEffort') !== window.previousEnumField");
    assert.match(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), /reasoningEffort = high/);
    await js("document.getElementById('setting-AI.reasoningEffort').scrollIntoView({block:'center'})");
    await capture('enum-settings');
    await js("document.querySelector('[data-view=home]').click();document.getElementById('primary-action').click()");
    await wait("document.getElementById('status-pill').textContent.includes('Server online')");
    assert.equal(await js("document.getElementById('observer-button').disabled"), false);
    assert.equal(await js("document.getElementById('quick-backup').disabled && document.getElementById('wipe-button').disabled"), true);
    await wait("document.getElementById('population-capacity').textContent === '1,700 / 1,700'");
    assert.equal(await js("document.getElementById('server-hint').textContent"), 'Login server: 100.92.15.42:2106');
    assert.equal(await js("document.getElementById('population-progress').value"), 1700);
    assert.equal(await js("document.getElementById('population-progress').max"), 1700);
    assert.equal(await js("document.getElementById('population-players').textContent"), 'Players online: 3');
    await capture('home-online');
    const bounds = await js("(() => {const r=document.getElementById('primary-action').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    window.webContents.sendInputEvent({type:'mouseMove',...bounds});
    await wait("getComputedStyle(document.getElementById('primary-action')).backgroundColor === 'rgb(90, 57, 48)'");
    assert.equal(await js("getComputedStyle(document.getElementById('primary-action')).color"), 'rgb(255, 215, 200)');
    await capture('stop-hover');
    window.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});
    await js("document.querySelector('[data-view=console]').click()");
    await wait("document.getElementById('console-output').textContent.includes('successful init')");
    await capture('console');
    await js("document.querySelector('[data-view=home]').click();document.getElementById('primary-action').click()");
    await wait("document.getElementById('status-pill').textContent.includes('Server offline') && !document.getElementById('primary-action').disabled");
    assert.equal(await js("document.getElementById('observer-button').disabled"), true);
    assert.equal(await js("document.getElementById('population-area').hidden"), true);
    assert.equal(await fs.promises.readFile(path.join(root, 'tmp/drained'), 'utf8'), 'yes');
    await js("document.querySelector('[data-view=updates]').click()");
    controller.state.launcherUpdate = { currentVersion: '0.2.0', availableVersion: '0.3.0', status: 'downloading', supported: true, percent: 47 };
    controller.publish();
    await wait("document.getElementById('launcher-update-progress').value === 47 && !document.getElementById('launcher-update-progress').hidden");
    controller.state.launcherUpdate.status = 'downloaded'; controller.publish();
    await wait("document.getElementById('launcher-update-action').textContent === 'Update & restart' && !document.getElementById('launcher-update-action').disabled");
    await js("document.getElementById('launcher-update-action').click()");
    await wait("document.getElementById('confirm-dialog').open");
    await js("document.getElementById('confirm-dialog').close('cancel')");
    await wait("!document.getElementById('launcher-update-action').disabled");
    assert.equal(controller.child, null);
    controller.state.launcherUpdate = { currentVersion: '0.2.0', availableVersion: '0.3.0', status: 'available', supported: false };
    controller.publish();
    await wait("document.getElementById('launcher-update-action').textContent.includes('Download') && !document.getElementById('launcher-update-action').disabled");
    if (process.platform === 'darwin') {
        assert.equal(await js("document.getElementById('launcher-update-action').textContent"), 'Download DMG ↗');
        assert.ok(await js("document.getElementById('launcher-update-description').textContent.includes('quit the launcher')"));
    }
    controller.state.launcherUpdate.notes = 'Launcher-only **fallback** notes';
    controller.state.launcherUpdate.url = 'https://github.com/pmbstyle/L2Solo/releases/tag/launcher-v0.3.0';
    controller.publish();
    await wait("document.querySelector('#release-notes strong')?.textContent === 'fallback'");
    assert.equal(await js("document.getElementById('release-tag').textContent"), 'launcher-v0.3.0');
    assert.equal(await js("document.getElementById('launcher-notes-panel') === null"), true);
    const notes = ['Server **0.1.0-preview.4** · Launcher **0.2.0-preview.4**', '## What changed',
        '- Readable **release notes**\n- World backups and server updates', 'Commit `a037a00f4a3bb8be0d3418b225ae287e60fb8f71`.',
        '[View changes](https://github.com/pmbstyle/L2Solo/releases/tag/server-v0.1.0-preview.4)',
        '> Your world stays yours.', '```ini\n[AI]\nenabled = false\n```'].join('\n\n');
    controller.state.releaseChannel = 'preview';
    controller.state.latest = { tag: 'server-v0.1.0-preview.4', notes, publishedAt: '2026-11-03T12:00:00Z', updateAvailable: true,
        url: 'https://github.com/pmbstyle/L2Solo/releases/tag/server-v0.1.0-preview.4' };
    controller.state.launcherUpdate = { currentVersion: '0.2.0-preview.3', availableVersion: '0.2.0-preview.4', status: 'available', supported: false,
        notes, url: 'https://github.com/pmbstyle/L2Solo/releases/tag/launcher-v0.2.0-preview.4' };
    controller.publish();
    await wait("document.querySelector('#release-notes h2')?.textContent === 'What changed'");
    assert.equal(await js("document.querySelectorAll('#release-notes').length"), 1);
    assert.equal(await js("document.querySelectorAll('#release-notes li').length"), 2);
    assert.equal(await js("document.querySelectorAll('#release-notes pre code').length"), 1);
    assert.equal(await js("document.getElementById('release-notes').textContent.includes('**')"), false);
    assert.equal(await js("document.getElementById('release-notes').textContent.includes('Launcher-only')"), false);
    assert.equal(await js("document.getElementById('server-release-label').textContent"), 'SERVER · PREVIEW');
    const { shell } = require('electron'), openExternal = shell.openExternal, opened = [];
    shell.openExternal = async url => { opened.push(url); };
    try {
        await js("document.querySelector('#release-notes a').click()");
        const deadline = Date.now() + 5000;
        while (!opened.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.deepEqual(opened, [controller.state.latest.url]);
    } finally { shell.openExternal = openExternal; }
    await capture('updates');
    controller.state.latest.notes = '<img src=x onerror="window.__notesExecuted=true">\n\n[bad](javascript:alert(1))\n\n![<svg onload=alert(1)>](https://example.invalid/image.png)';
    controller.publish();
    await wait("document.getElementById('release-notes').textContent.includes('<img')");
    assert.equal(await js("document.querySelector('#release-notes img, #release-notes svg, #release-notes script, #release-notes a') === null"), true);
    assert.equal(await js("window.__notesExecuted === undefined"), true);
    const catalogReleases = controller.catalog.releases;
    try {
        controller.catalog.releases = async () => [];
        // Exercise the real combined IPC check with an empty release catalog.
        controller.state.releaseChannel = controller.channel;
        controller.state.launcherUpdate.status = 'idle';
        controller.publish();
        await js("document.getElementById('updates-check').click()");
        await wait("document.getElementById('toast').textContent === 'Everything is up to date.' && !document.getElementById('updates-check').disabled");
        assert.equal(await js("document.getElementById('update-description').textContent"), 'The server is up to date.');
        assert.equal(await js("document.getElementById('launcher-update-description').textContent"), 'The launcher is up to date.');
        assert.equal(await js("document.getElementById('release-notes').textContent.trim()"), 'No new release notes.');
        assert.equal(await js("document.getElementById('error-banner').hidden && document.getElementById('update-dot').hidden && document.getElementById('install-update').disabled"), true);
        await capture('updates-current');
        controller.catalog.releases = async () => { throw new Error('Network unavailable. Please try again.'); };
        await js("document.getElementById('updates-check').click()");
        await wait("!document.getElementById('error-banner').hidden && !document.getElementById('updates-check').disabled");
        assert.equal(await js("document.getElementById('update-title').textContent"), 'Unable to check for updates');
        assert.equal(await js("document.getElementById('launcher-update-description').textContent"), 'Network unavailable. Please try again.');
        assert.equal(await js("document.getElementById('toast').hidden"), true);
        controller.catalog.releases = async () => [{ tag_name: `launcher-v1.0.0${controller.channel === 'preview' ? '-preview.1' : ''}`,
            prerelease: controller.channel === 'preview', assets: [] }];
        await js("document.getElementById('updates-check').click()");
        await wait("document.getElementById('error-message').textContent === 'The launcher release is incomplete.' && !document.getElementById('updates-check').disabled");
        assert.equal(await js("document.getElementById('update-description').textContent"), 'The server is up to date.');
        assert.equal(await js("document.getElementById('toast').hidden"), true, 'a partial check failure must not show a success notification');
    } finally { controller.catalog.releases = catalogReleases; }
    assert.deepEqual(rendererErrors, []);
    await fs.promises.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks: ['home', 'compact layout', 'brand casing', 'notification overlay', 'notification dismissal and five-second expiry', 'notification timer reset', 'login address', 'bot target separate from players', 'settings help and units', 'hidden settings excluded from search', 'semantic settings groups', 'stop hover', 'unified AI', 'backup create/restore/delete', 'wipe confirmation/cancel/scope', 'world tools disabled online', 'observer availability', 'navigation', 'settings saved to INI', 'enum selects', 'enum saved to INI', 'start', 'console streaming', 'graceful stop', 'updates', 'no-update state', 'update request failure'], rendererErrors }, null, 2));
    console.log('Desktop UI smoke passed: app layout, backups, wipe, settings, start/stop, Markdown notes, single notes panel, safe links and escaped HTML.');
};
