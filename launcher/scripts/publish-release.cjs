'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { plan } = require('./release-plan.cjs');
const { collect } = require('./launcher-assets.cjs');
const { assetUrl, repository, listReleases, channelOf, latestRelease, launcherRelease, validateManifest, download } = require('../main/releases.cjs');
const { readJson, writeJson, sha256 } = require('../main/files.cjs');

const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function publishedRelease(tag, ghClient) {
    // The anonymous release list can still contain its pre-publication cached
    // response. Known preview tags use the authenticated exact-tag endpoint.
    const release = JSON.parse(ghClient(['api', `repos/${repository}/releases/tags/${tag}`]));
    if (release.tag_name !== tag || release.draft) throw new Error(`Release ${tag} has not finished publication.`);
    return release;
}
async function serverInstallers(directory, manifest, fetcher = fetch, releases) {
    const channel = channelOf(manifest.tag);
    const available = releases || await listReleases(fetcher);
    const candidates = channel === 'preview' ? available.filter(item => item.tag_name === `launcher-v${manifest.minimumLauncherVersion}`) : available;
    const launcher = await launcherRelease(fetcher, candidates, manifest.minimumLauncherVersion, channel);
    if (channel === 'preview' && (launcher.version !== manifest.minimumLauncherVersion || launcher.manifest.sourceCommit !== manifest.sourceCommit)) {
        throw new Error('A preview server requires the matching launcher from the same source commit.');
    }
    const names = [...new Set(Object.values(launcher.manifest.installers).flat())];
    for (const name of names) {
        const asset = launcher.manifest.assets.find(asset => asset.name === name);
        const file = path.join(directory, name);
        if (fs.existsSync(file)) {
            if ((await fs.promises.stat(file)).size !== asset.bytes || await sha256(file) !== asset.sha256) throw new Error(`Existing installer checksum mismatch: ${name}`);
        } else await download(assetUrl(launcher.tag, name), file, asset, () => {}, fetcher);
    }
    await writeJson(path.join(directory, 'launcher-release.json'), launcher.manifest);
    manifest.launcher = { version: launcher.version, tag: launcher.tag };
    await writeJson(path.join(directory, 'l2solo-release.json'), manifest);
    return launcher.version;
}

async function publish({ tag = process.env.RELEASE_TAG, directory = path.resolve(process.env.RELEASE_ASSETS || 'dist/release'), ghClient = gh, fetcher = fetch,
    packageRoot = path.resolve(__dirname, '../..'), sourceCommit = process.env.RELEASE_SOURCE_SHA } = {}) {
    const serverPackage = await readJson(path.join(packageRoot, 'package.json'));
    const launcherPackage = await readJson(path.join(packageRoot, 'launcher/package.json'));
    const release = plan(tag, serverPackage, launcherPackage);
    sourceCommit ||= launcherPackage.releaseSourceCommit;
    const notes = (await fs.promises.readFile(path.join(packageRoot, 'release-notes', `${release.component}.md`), 'utf8')).trim();
    if (!notes) throw new Error('Write release notes before publishing.');
    let existing;
    try { existing = JSON.parse(ghClient(['release', 'view', tag, '--repo', repository, '--json', 'isDraft,isPrerelease,targetCommitish'])); }
    catch (error) {
        if (!/not found|404|release not found/i.test(`${error.stderr || ''}${error.message}`)) throw error;
    }
    if (existing && !existing.isDraft && release.channel !== 'preview') throw new Error('This release is already published. Use a new version instead of replacing its files.');
    if (release.channel === 'preview' && (sourceCommit !== launcherPackage.releaseSourceCommit || existing && existing.targetCommitish !== sourceCommit)) throw new Error('Preview source commit does not match the prepared build.');
    const releases = release.channel === 'preview' ? [] : await listReleases(fetcher);
    if (existing && !existing.isDraft) {
        if (!existing.isPrerelease) throw new Error('A published preview must remain a prerelease.');
        const published = [publishedRelease(tag, ghClient)];
        const verified = release.component === 'launcher' ? await launcherRelease(fetcher, published, '0.0.0', 'preview')
            : await latestRelease(fetcher, published, 'preview');
        if (verified.manifest.sourceCommit !== sourceCommit) throw new Error('Published preview belongs to a different source commit.');
        console.log(`Verified existing ${tag}; published files were not replaced.`);
        return;
    }
    let launcherVersion;
    if (release.component === 'launcher') await collect(directory, release.version, sourceCommit);
    else {
        const manifest = validateManifest(await readJson(path.join(directory, 'l2solo-release.json')), tag);
        if (sourceCommit && manifest.sourceCommit !== sourceCommit) throw new Error('Server artifacts belong to a different source commit.');
        const archive = path.join(directory, manifest.archive.name);
        if ((await fs.promises.stat(archive)).size !== manifest.archive.bytes || await sha256(archive) !== manifest.archive.sha256) throw new Error('Server release archive checksum mismatch.');
        const candidates = release.channel === 'preview'
            ? [publishedRelease(`launcher-v${manifest.minimumLauncherVersion}`, ghClient)] : releases;
        launcherVersion = await serverInstallers(directory, manifest, fetcher, candidates);
    }
    const title = `${release.component === 'server' ? 'L2Solo Server' : 'L2Solo Launcher'} ${release.version}`;
    const prefix = launcherVersion ? `Server **${release.version}** · Launcher **${launcherVersion}**\n\nDownload the installer for your platform below. It installs the server and its Node.js runtime; Git and a system Node.js installation are not required.\n\n` : '';
    const preview = release.channel === 'preview' ? `Preview build from develop, commit \`${sourceCommit}\`. Use a separate test world.\n\n` : '';
    const body = path.join(path.dirname(directory), `release-notes-${release.component}.md`);
    await fs.promises.writeFile(body, `${prefix}${preview}${notes}\n`);
    if (!existing) {
        ghClient(['release', 'create', tag, '--repo', repository, '--draft', '--title', title, '--notes-file', body,
            ...(release.channel === 'preview' ? ['--target', sourceCommit, '--prerelease', '--latest=false'] : ['--verify-tag'])]);
    }
    const files = (await fs.promises.readdir(directory)).filter(name => /\.(zip|dmg|exe|AppImage|deb|blockmap|json|yml)$/.test(name));
    for (const file of files) ghClient(['release', 'upload', tag, path.join(directory, file), '--repo', repository, '--clobber']);
    const uploaded = JSON.parse(ghClient(['release', 'view', tag, '--repo', repository, '--json', 'assets'])).assets;
    if (!Array.isArray(uploaded) || uploaded.length !== files.length) throw new Error('Draft release contains missing or unexpected assets.');
    for (const file of files) {
        const asset = uploaded.find(asset => asset.name === file);
        if (!asset || asset.size !== (await fs.promises.stat(path.join(directory, file))).size) throw new Error(`Draft release asset is incomplete: ${file}`);
    }
    // Every file is attached before this single visibility change. Launcher
    // releases never move the server's public Latest pointer.
    ghClient(['release', 'edit', tag, '--repo', repository, '--notes-file', body, '--draft=false',
        `--prerelease=${release.channel === 'preview'}`, `--latest=${release.channel === 'stable' && release.component === 'server'}`]);
    console.log(`Published ${tag}${launcherVersion ? ` with original launcher ${launcherVersion} installers` : ''}.`);
}
if (require.main === module) publish().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publish, serverInstallers };
