'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { build, Platform, Arch } = require('electron-builder');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js');

const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-installer-check-'));
const windows = process.platform === 'win32';
const wine = process.env.L2SOLO_NSIS_WINE;
const run = (file, args = [], options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 60000, ...options });
const nsisString = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
const windowsPath = value => windows ? value : `Z:${value.replaceAll('/', '\\')}`;
console.log(`Windows installer check artifacts: ${directory}`);

async function main() {
    const app = path.join(directory, 'app'), product = 'L2Solo Installer Test';
    fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(app, `${product}.exe`), 'test application payload');
    fs.writeFileSync(path.join(app, 'resources/marker.txt'), 'old installation must survive a failed preflight');
    const artifacts = await build({ projectDir: project, prepackaged: app, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        config: { appId: `com.l2solo.installer-test.${crypto.randomUUID()}`, productName: product, extraMetadata: { name: 'l2solo-installer-test' },
            directories: { output: path.join(directory, 'dist') }, win: { signAndEditExecutable: false },
            nsis: { runAfterFinish: false }, publish: null } });
    const installer = artifacts.find(file => file.endsWith('-Setup.exe'));
    assert.ok(installer, 'the stock NSIS installer and its uninstaller must compile with our include');

    const driver = path.join(directory, 'probe.exe');
    const compiler = await getMakeNsisPath();
    const script = `Unicode true
Name "Installer access check"
OutFile "${nsisString(driver)}"
RequestExecutionLevel user
SilentInstall silent
!include "${nsisString(path.join(project, 'build/windows-preflight.nsh'))}"
Section
  ReadINIStr $INSTDIR "$EXEDIR\\probe.ini" "case" "directory"
  StrCpy $L2SoloAccessError 0
  Push $INSTDIR
  Call L2SoloProbeDirectory
  WriteINIStr "$EXEDIR\\result.ini" "result" "error" $L2SoloAccessError
  WriteINIStr "$EXEDIR\\result.ini" "result" "path" $L2SoloAccessPath
SectionEnd
`;
    run(compiler.path, [windows ? '/V2' : '-V2', '-'], { input: script, env: { ...process.env, ...compiler.env } });
    console.log('NSIS installer, uninstaller and preflight driver compiled.');
    if (!windows && !wine) {
        console.log('Native Windows access checks require Windows; compilation passed.');
        return;
    }

    const env = { ...process.env, WINEPREFIX: path.join(directory, 'wine'), WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=', MVK_CONFIG_LOG_LEVEL: '0' };
    const probe = folder => {
        fs.writeFileSync(path.join(directory, 'probe.ini'), `\ufeff[case]\r\ndirectory=${windowsPath(folder)}\r\n`, 'utf16le');
        fs.writeFileSync(path.join(directory, 'result.ini'), '\ufeff', 'utf16le');
        if (windows) run(driver);
        else run(wine, [driver], { env });
        const result = fs.readFileSync(path.join(directory, 'result.ini'), 'utf16le');
        return { error: Number(result.match(/^error=(\d+)/m)?.[1]), path: result.match(/^path=(.*)/m)?.[1].trim() };
    };
    const writable = path.join(directory, 'writable folder Δ');
    fs.mkdirSync(path.join(writable, 'nested'), { recursive: true });
    const sentinel = path.join(writable, 'nested', 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep these bytes');
    assert.equal(probe(writable).error, 0);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep these bytes');
    assert.deepEqual(fs.readdirSync(writable), ['nested']);
    assert.deepEqual(fs.readdirSync(path.dirname(sentinel)), ['sentinel.txt']);
    assert.notEqual(probe(path.join(directory, 'missing')).error, 0);
    const mode = fs.statSync(sentinel).mode;
    fs.chmodSync(sentinel, 0o444);
    try { assert.equal(probe(writable).error, 60001); }
    finally { fs.chmodSync(sentinel, mode); }
    console.log('Writable and missing folders checked; existing files are unchanged and probes are removed.');
    if (!windows) {
        console.log('Wine does not validate Windows ACLs or UAC. Run this check on Windows for those cases.');
        return;
    }

    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe');
    const sid = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']).trim();
    const withDeniedWrite = (file, check) => {
        run(icacls, [file, '/deny', `*${sid}:(W,D)`]);
        try { check(); }
        finally { run(icacls, [file, '/remove:d', `*${sid}`]); }
    };
    withDeniedWrite(writable, () => assert.equal(probe(writable).error, 5));
    withDeniedWrite(sentinel, () => {
        const result = probe(writable);
        assert.equal(result.error, 5);
        assert.equal(result.path, sentinel);
    });
    // Denied Windows write/delete masks can also prevent Node's synchronous
    // file open. Verify preservation after the fixture restores normal ACLs.
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep these bytes');
    const linked = path.join(directory, 'linked');
    fs.symlinkSync(writable, linked, 'junction');
    try { assert.equal(probe(linked).error, 60002); }
    finally { fs.unlinkSync(linked); }

    const destination = path.join(directory, 'installed');
    const invoke = (file, args) => run(file, args, { windowsVerbatimArguments: true });
    invoke(installer, ['/S', '/currentuser', `/D=${destination}`]);
    const marker = path.join(destination, 'resources/marker.txt');
    const original = fs.readFileSync(marker, 'utf8');
    const uninstaller = path.join(destination, `Uninstall ${product}.exe`);
    try {
        withDeniedWrite(destination, () => {
            assert.throws(() => invoke(installer, ['/S', '--updated', '/currentuser', `/D=${destination}`]),
                error => error.status === 5);
        });
        assert.equal(fs.readFileSync(marker, 'utf8'), original);
        assert.ok(fs.existsSync(uninstaller));
        const literal = `'${marker.replaceAll("'", "''")}'`;
        const keeper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
            `$file=[System.IO.File]::Open(${literal},'Open','Read','None');[Console]::WriteLine('locked');[Console]::ReadLine() > $null;$file.Dispose()`]);
        const closed = new Promise(resolve => keeper.once('close', resolve));
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timed out locking the test file')), 10000);
                keeper.once('error', error => { clearTimeout(timer); reject(error); });
                keeper.stdout.on('data', bytes => { if (bytes.toString().includes('locked')) { clearTimeout(timer); resolve(); } });
            });
            assert.equal(probe(destination).error, 32);
            assert.throws(() => invoke(installer, ['/S', '--updated', '/currentuser', `/D=${destination}`]),
                error => error.status === 32);
            assert.ok(fs.existsSync(uninstaller));
        } finally { keeper.stdin.end('\n'); await closed; }
        assert.equal(fs.readFileSync(marker, 'utf8'), original);
        invoke(installer, ['/S', '--updated', '/currentuser', `/D=${destination}`]);
        assert.equal(fs.readFileSync(marker, 'utf8'), original);
    } finally {
        // With _?= NSIS does not copy itself to TEMP. Run outside the app folder,
        // like the updater does, so the running-app check cannot match itself.
        const cleanup = path.join(directory, 'cleanup-uninstaller.exe');
        fs.copyFileSync(uninstaller, cleanup);
        invoke(cleanup, ['/S', '/KEEP_APP_DATA', '/currentuser', `_?=${destination}`]);
    }
    console.log('Windows ACL denial, locked files, preservation of the old installation and successful retry passed.');
    console.log('Interactive UAC consent/cancellation and same-account elevation still require a Windows walkthrough.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
    // Electron Builder's async cleanup hook can call process.exit(0).
    // Keep a build/check failure fatal after those cleanup handlers finish.
    process.on('exit', () => { process.exitCode = 1; });
});
