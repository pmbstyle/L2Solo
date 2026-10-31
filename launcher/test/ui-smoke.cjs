'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function smoke({ window, controller, directory }) {
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
    const capture = async name => {
        await window.webContents.insertCSS('*{animation:none!important;transition:none!important}');
        await new Promise(resolve => setTimeout(resolve, 150));
        await fs.promises.writeFile(path.join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    const rendererErrors = [];
    window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
    await put('package.json', JSON.stringify({ version: '0.1.0' }));
    await put('config/default.ini', await fs.promises.readFile(path.resolve(__dirname, '../../config/default.ini'), 'utf8'));
    await put('config/local.ini', '[OpenRouter]\nreasoningEffort = legacy-test-value\n');
    await put('scripts/geodata-release.json', '{}');
    await put('scripts/geodata-bootstrap.js', 'module.exports = { async inspectDirectory() { return {valid:true,fileCount:141}; }, async ensureGeodata() { return {valid:true,fileCount:141}; } };');
    await put('scripts/run-server.js', "console.log('GameServer :: successful init'); process.on('message',m=>{if(m.type==='shutdown'){require('fs').writeFileSync('tmp/drained','yes');process.exit(0);}});process.on('disconnect',()=>process.exit(0));");
    await controller.choose(root);
    await wait("document.getElementById('primary-label').textContent === 'Start server'");
    await wait("document.querySelectorAll('.news-card').length === 3");
    await capture('overview');
    await js("document.querySelector('[data-view=settings]').click()");
    await wait("document.getElementById('setting-BotPopulation.maxPlayingPopulation') !== null");
    const population = await js("document.getElementById('setting-BotPopulation.maxPlayingPopulation').value === '600' ? '601' : '600'");
    await js(`const field=document.getElementById('setting-BotPopulation.maxPlayingPopulation');field.value=${JSON.stringify(population)};field.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('save-settings').click()`);
    await wait("document.getElementById('toast').textContent.startsWith('Settings saved')");
    assert.match(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), new RegExp(`maxPlayingPopulation = ${population}`));
    await capture('settings');
    await js("Array.from(document.querySelectorAll('#settings-nav button')).find(button => button.textContent === 'OpenRouter').click()");
    await wait("document.getElementById('setting-OpenRouter.reasoningEffort') !== null");
    const enumControls = await js(`(() => {
        const effort = document.getElementById('setting-OpenRouter.reasoningEffort');
        return { tag: effort.tagName, value: effort.value,
            choices: Array.from(effort.options).filter(option => !option.disabled).map(option => option.value),
            unknownDisabled: effort.selectedOptions[0].disabled,
            completion: document.getElementById('setting-OpenRouter.completionLimitParam').tagName,
            sort: document.getElementById('setting-OpenRouter.providerSort').tagName,
            endpoint: document.getElementById('setting-OpenRouter.apiUrl').tagName };
    })()`);
    assert.deepEqual(enumControls, { tag: 'SELECT', value: 'legacy-test-value', choices: ['off', 'low', 'medium', 'high'],
        unknownDisabled: true, completion: 'SELECT', sort: 'SELECT', endpoint: 'INPUT' });
    await js(`(() => {
        window.previousEnumField = document.getElementById('setting-OpenRouter.reasoningEffort');
        window.previousEnumField.value = 'high';
        window.previousEnumField.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-settings').click();
    })()`);
    await wait("document.getElementById('setting-OpenRouter.reasoningEffort') !== window.previousEnumField");
    assert.match(await fs.promises.readFile(path.join(root, 'config/local.ini'), 'utf8'), /reasoningEffort = high/);
    await js("document.getElementById('setting-OpenRouter.reasoningEffort').scrollIntoView({block:'center'})");
    await capture('enum-settings');
    await js("document.querySelector('[data-view=home]').click();document.getElementById('primary-action').click()");
    await wait("document.getElementById('status-pill').textContent.includes('Server online')");
    await js("document.querySelector('[data-view=console]').click()");
    await wait("document.getElementById('console-output').textContent.includes('successful init')");
    await capture('console');
    await js("document.querySelector('[data-view=home]').click();document.getElementById('primary-action').click()");
    await wait("document.getElementById('status-pill').textContent.includes('Server offline') && !document.getElementById('primary-action').disabled");
    assert.equal(await fs.promises.readFile(path.join(root, 'tmp/drained'), 'utf8'), 'yes');
    await js("document.querySelector('[data-view=updates]').click()");
    await capture('updates');
    assert.deepEqual(rendererErrors, []);
    await fs.promises.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks: ['overview', 'navigation', 'settings saved to INI', 'enum selects', 'enum saved to INI', 'start', 'console streaming', 'graceful stop', 'updates'], rendererErrors }, null, 2));
    console.log('Desktop UI smoke passed: navigation, settings, start/stop, console.');
};
