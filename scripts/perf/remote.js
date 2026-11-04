'use strict';

// Window runs on another machine over ssh: a quiet server gives numbers that do not depend on what this
// laptop does meanwhile. The commits are pushed there (no GitHub), each runs `perf.js run` in its own
// checkout, and the run's small files (summary.json, run.json, server.log) come back to
// tmp/perf/runs/<host>-<run>, where compare reads them; the report is in the job's log, printed by the commit
// under test (an older commit writes an older summary); the profiles stay on the remote. One job
// at a time per machine (flock): two servers on one machine spoil each other's numbers. A job runs detached,
// so a dropped ssh or a closed laptop does not stop it: `remote pull` gets its results later.
//
// Remote layout, under ~/perf of the ssh user (`remote setup` makes it; geodata and saves are copied once):
//   node/          Node of the laptop's version     geodata/   a geodata folder
//   saves/         launcher saves (upload-save)     l2solo.git bare repository, commits under refs/perf/<sha>
//   src/<sha>/     a checkout per commit            runs/      every run folder (each checkout links to it)
//   jobs/<id>/     job.sh, log, status.json         perf.lock, current (the running job)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomBytes } = require('crypto');
const Window = require('./window');
const Compare = require('./compare');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = 'perf';
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30'];
const FILES = ['summary.json', 'run.json', 'server.log'];
const POLL_MS = 15000;
const NAME = /^[\w.+-]+$/;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const say = (text) => console.log(`remote :: ${text}`);
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function settings(flags) {
    const config = options.default.PerfRemote || {};
    const count = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
    const host = String(flags.host || config.host || '').trim();
    if (!host) throw new Error('set [PerfRemote] host (an ssh name from ~/.ssh/config) or --host=<name>');
    return { host, keepCheckouts: count(config.keepCheckouts, 10), keepRunsDays: count(config.keepRunsDays, 30) };
}

function exec(command, args, { input, allowFail = false } = {}) {
    const result = spawnSync(command, args, { cwd: ROOT, input, encoding: 'utf8', maxBuffer: 64 * 1048576,
        env: { ...process.env, GIT_SSH_COMMAND: `ssh ${SSH.join(' ')}` } });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFail) {
        throw new Error(`${command} ${args[0]}: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    }
    return result;
}

// A bash script on the remote, given on stdin (no quoting through ssh's command line).
const remote = (s, script, opts) => exec('ssh', [...SSH, s.host, 'bash -s'], { ...opts, input: `B="$HOME/${BASE}"\n${script}` });

// A job's state on the remote: its status.json, else running while its bash lives; a job that died
// without a status (reboot, OOM) or an id that is not there ends the wait instead of hanging it.
const stateScript = (job) => `J=${job}
if [ ! -d "$J" ]; then echo '{"state":"missing"}'
elif [ -f "$J/status.json" ]; then cat "$J/status.json"
elif [ -f "$J/pid" ] && ! kill -0 "$(cat "$J/pid")" 2>/dev/null; then echo '{"state":"died","error":"ended without a status (reboot, killed?); see its log"}'
else echo '{"state":"running"}'; fi`;

// The job: every commit in turn under the machine's lock; status.json says where it is.
function jobScript(s, id, shas, args) {
    return `#!/bin/bash
# A perf job written by scripts/perf/remote.js.
set -u
B="$HOME/${BASE}"; JOB="$B/jobs/${id}"
echo $$ > "$JOB/pid"
status() { printf '%s\\n' "$1" > "$JOB/status.tmp" && mv "$JOB/status.tmp" "$JOB/status.json"; }
# Retention, after every job that held the lock (a failed one too): checkouts past the newest
# ${s.keepCheckouts} and their pushed refs, run folders and jobs older than ${s.keepRunsDays} days.
prune() {
    ls -1dt "$B"/src/*/ 2>/dev/null | tail -n +${s.keepCheckouts + 1} | while read -r dir; do
        git --git-dir="$B/l2solo.git" worktree remove --force "$dir" || rm -rf "$dir"
    done
    git --git-dir="$B/l2solo.git" worktree prune
    git --git-dir="$B/l2solo.git" for-each-ref --format='%(refname:lstrip=2)' refs/perf/ | while read -r sha; do
        [ -d "$B/src/$sha" ] || git --git-dir="$B/l2solo.git" update-ref -d "refs/perf/$sha"
    done
    git --git-dir="$B/l2solo.git" gc --auto --quiet
    find "$B/runs" "$B/jobs" -mindepth 1 -maxdepth 1 -type d -mtime +${s.keepRunsDays} -exec rm -rf {} +
}
exec 9>"$B/perf.lock"
flock -n 9 || { status '{"state":"busy"}'; exit 75; }
echo ${id} > "$B/current"
trap 'rm -f "$B/current"; prune' EXIT
export PATH="$B/node/bin:$PATH" L2NODE_GEODATA_DIR="$B/geodata"
mkdir -p "$B/runs" "$B/src"
runs=""
fail() { status '{"state":"failed","error":"'"$1"'","runs":['"$runs"']}'; exit 1; }
for sha in ${shas.join(' ')}; do
    src="$B/src/$sha"
    if [ ! -f "$src/.perf-ready" ]; then
        echo "remote :: checkout and npm install for $sha"
        rm -rf "$src"; git --git-dir="$B/l2solo.git" worktree prune
        git --git-dir="$B/l2solo.git" worktree add --quiet --detach "$src" "$sha" || fail "checkout $sha"
        ( cd "$src" && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error;
          else npm install --no-audit --no-fund --loglevel=error; fi ) || fail "npm install $sha"
        mkdir -p "$src/tmp/perf" && ln -sfn "$B/runs" "$src/tmp/perf/runs" && touch "$src/.perf-ready"
    fi
    touch "$src"
    touch "$JOB/mark-$sha"
    echo "remote :: run $sha"
    ( cd "$src" && node scripts/perf.js run --saves="$B/saves" ${args.map(quote).join(' ')} ); code=$?
    run=$(find "$B/runs" -mindepth 1 -maxdepth 1 -type d -name "\${sha:0:9}*" -newer "$JOB/mark-$sha" -printf '%T@ %f\\n' | sort -n | tail -1 | cut -d' ' -f2)
    [ -n "$run" ] && runs="$runs\${runs:+,}\\"$run\\""
    [ "$code" -eq 0 ] || fail "perf.js run exited $code for $sha"
done
status '{"state":"done","runs":['"$runs"']}'
`;
}

function commitOf(ref) {
    const result = exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    if (result.status !== 0) throw new Error(`no commit ${ref}`);
    return result.stdout.trim();
}

function setup(flags) {
    const s = settings(flags);
    const version = process.version;
    const out = remote(s, `set -e
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported machine $(uname -m)"; exit 1 ;; esac
tarball="node-${version}-linux-$arch.tar.xz"
mkdir -p "$B/saves" "$B/runs" "$B/src" "$B/jobs"
[ -d "$B/l2solo.git" ] || git init --quiet --bare "$B/l2solo.git"
if [ "$("$B/node/bin/node" -v 2>/dev/null)" != "${version}" ]; then
    echo "installing Node ${version}"
    tmp=$(mktemp -d); cd "$tmp"
    curl -fsSL -O "https://nodejs.org/dist/${version}/$tarball"
    curl -fsSL https://nodejs.org/dist/${version}/SHASUMS256.txt | grep " $tarball$" | sha256sum -c --quiet -
    rm -rf "$B/node"; mkdir -p "$B/node"; tar -xJf "$tarball" -C "$B/node" --strip-components=1; cd; rm -rf "$tmp"
fi
echo "node $("$B/node/bin/node" -v)"
command -v flock >/dev/null || echo "missing: flock (util-linux)"
[ -f "$B/geodata/.l2solo-geodata-manifest.json" ] || echo "missing: geodata in ~/${BASE}/geodata"
echo "saves $(find "$B/saves" -mindepth 1 -maxdepth 1 -type d | wc -l)"
echo "cores $(nproc), memory $(free -m | awk '/^Mem:/ {print $2}') MB, load $(cut -d' ' -f1 /proc/loadavg)"
`).stdout;
    process.stdout.write(`${out.trimEnd().replace(/^/gm, `${s.host} :: `)}\n`);
    if (/missing: geodata/.test(out)) say(`copy one: scp -r <geodata folder> ${s.host}:${BASE}/geodata`);
}

async function run(flags) {
    const s = settings(flags);
    if (!flags.save) throw new Error('Use --save=<id> (perf.js remote saves lists the remote ones)');
    const refs = String(flags.ref || 'HEAD').split(',').map(ref => ref.trim()).filter(Boolean);
    const shas = refs.map(commitOf);
    const dirty = exec('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim() !== '';
    if (dirty && shas.includes(commitOf('HEAD'))) say('uncommitted changes are not in the run: HEAD runs as committed');
    // Before the push: a remote without setup would fail it with a git error, a missing flock would read as busy.
    const ready = remote(s, `[ -d "$B/l2solo.git" ] || { echo "no ~/${BASE}/l2solo.git: perf.js remote setup"; exit 0; }
command -v flock >/dev/null || { echo "no flock (util-linux) on the remote"; exit 0; }
flock -n "$B/perf.lock" true || { echo "running another job ($(cat "$B/current" 2>/dev/null)): perf.js remote status"; exit 0; }
echo ok`).stdout.trim();
    if (ready !== 'ok') throw new Error(`${s.host}: ${ready}`);
    const args = Object.entries(flags).filter(([key]) => !['ref', 'host', 'saves'].includes(key))
        .map(([key, value]) => `--${key}=${value}`);
    exec('git', ['push', '--quiet', `${s.host}:${BASE}/l2solo.git`, ...shas.map(sha => `${sha}:refs/perf/${sha}`)]);
    const id = `${Window.stamp()}-${randomBytes(2).toString('hex')}`;
    const started = remote(s, `J="$B/jobs/${id}"
if ! flock -n "$B/perf.lock" true; then echo "busy $(cat "$B/current" 2>/dev/null)"; exit 0; fi
mkdir -p "$J" && cat > "$J/job.sh" <<'L2SOLO_PERF_JOB'
${jobScript(s, id, shas, args)}L2SOLO_PERF_JOB
setsid nohup bash "$J/job.sh" > "$J/log" 2>&1 < /dev/null &
echo started
`).stdout.trim();
    if (started !== 'started') throw new Error(`${s.host} is running another job (${started.replace(/^busy ?/, '') || 'unknown'}): perf.js remote status`);
    say(`job ${id} on ${s.host}: ${refs.map((ref, i) => `${ref} (${shas[i].slice(0, 9)})`).join(', ')}`);
    const status = await follow(s, id);
    if (status) finish(s, id, status);
}

// Prints the job's progress lines until it ends; Ctrl-C leaves it running.
async function follow(s, id) {
    let offset = 0, interrupted = false;
    const stop = () => { interrupted = true; };
    process.once('SIGINT', stop);
    try {
        for (;;) {
            const result = remote(s, `${stateScript(`"$B/jobs/${id}"`)}\necho ::log::; tail -c +${offset + 1} "$J/log" 2>/dev/null`,
                { allowFail: true });
            if (result.status === 0) {
                const [status, tail = ''] = result.stdout.split('\n::log::\n');
                // Whole lines only: a line still being written is read again on the next poll.
                const log = tail.slice(0, tail.lastIndexOf('\n') + 1);
                offset += Buffer.byteLength(log);
                // The whole log: the report in it is printed by the commit under test, which wrote the summary.
                if (log) process.stdout.write(log);
                const state = JSON.parse(status);
                if (state.state !== 'running') return state;
            } else say(`ssh failed (${(result.stderr || '').trim()}); retrying`);
            for (let waited = 0; waited < POLL_MS && !interrupted; waited += 500) await sleep(500);
            if (interrupted) {
                say(`job ${id} goes on there; its results later: node scripts/perf.js remote pull ${id}`);
                return null;
            }
        }
    } finally { process.removeListener('SIGINT', stop); }
}

function finish(s, id, status) {
    if (status.state === 'busy') throw new Error(`${s.host} took another job first: perf.js remote status`);
    if (status.state === 'missing') throw new Error(`no job ${id} on ${s.host}: perf.js remote status`);
    const dirs = pull(s, id, status.runs || []);
    for (const dir of dirs.slice(1)) { console.log(''); Compare.compare(dirs[0], dir); }
    if (status.state !== 'done') throw new Error(`job ${id} ${status.state}: ${status.error}`);
}

// The small files of each run into tmp/perf/runs/<host>-<run>, marked by remote.json (report reads a full
// run folder, not these); a run without a summary is skipped.
function pull(s, id, runs) {
    return runs.filter(name => NAME.test(name)).flatMap(name => {
        const local = path.join(Window.PERF_DIR, 'runs', `${s.host}-${name}`);
        fs.mkdirSync(local, { recursive: true });
        const copied = exec('scp', [...SSH, '-q', ...FILES.map(file => `${s.host}:${BASE}/runs/${name}/${file}`), `${local}${path.sep}`],
            { allowFail: true });
        if (!fs.existsSync(path.join(local, 'summary.json'))) {
            fs.rmSync(local, { recursive: true, force: true });
            say(`${name}: no summary (${(copied.stderr || '').trim() || 'the run did not finish'}); see ${s.host}:${BASE}/runs/${name}/server.log`);
            return [];
        }
        fs.writeFileSync(path.join(local, 'remote.json'), `${JSON.stringify({ host: s.host, job: id, run: name })}\n`);
        say(`${name} -> ${path.relative(ROOT, local)}`);
        return [local];
    });
}

function jobStatus(s, id) {
    if (id && !NAME.test(id)) throw new Error(`bad job id ${id}`);
    const out = remote(s, `id=${id || '$(ls -1t "$B/jobs" 2>/dev/null | head -1)'}
[ -n "$id" ] || { echo; echo '{"state":"missing"}'; exit 0; }
echo "$id"; ${stateScript('"$B/jobs/$id"')}`).stdout.split('\n');
    return { id: out[0].trim() || '(none)', status: JSON.parse(out.slice(1).join('\n')) };
}

async function pullJob(words, flags) {
    const s = settings(flags);
    const { id, status } = jobStatus(s, words[1]);
    if (status.state === 'running') {
        say(`job ${id} is still running`);
        const done = await follow(s, id);
        if (done) finish(s, id, done);
        return;
    }
    if (status.state !== 'missing') process.stdout.write(remote(s, `cat "$B/jobs/${id}/log" 2>/dev/null`, { allowFail: true }).stdout);
    finish(s, id, status);
}

function printStatus(flags) {
    const s = settings(flags);
    const out = remote(s, `echo "current $(cat "$B/current" 2>/dev/null)"; echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
for j in $(ls -1t "$B/jobs" 2>/dev/null | head -8); do printf '%s\\t' "$j"; tr -d '\\n' < "$B/jobs/$j/status.json" 2>/dev/null || printf '{"state":"running"}'; echo; done`).stdout;
    const [current, load, ...jobs] = out.trim().split('\n');
    console.log(`${s.host}: ${current.trim() === 'current' ? 'idle' : `running ${current.slice(8)}`}, ${load}`);
    for (const line of jobs.filter(Boolean)) {
        const [id, text] = line.split('\t');
        let status;
        try { status = JSON.parse(text); } catch { status = { state: '?' }; }
        console.log(`  ${id}  ${status.state}${status.runs?.length ? `  ${status.runs.join(', ')}` : ''}${status.error ? `  (${status.error})` : ''}`);
    }
}

function printSaves(flags) {
    const s = settings(flags);
    const out = remote(s, `for f in "$B"/saves/*/save.json; do [ -f "$f" ] || continue
printf '%s\\t%s\\t' "$(basename "$(dirname "$f")")" "$(du -sm "$(dirname "$f")" | cut -f1)"; tr -d '\\n' < "$f"; echo; done`).stdout;
    const lines = out.split('\n').filter(Boolean);
    if (!lines.length) say(`no saves on ${s.host}: perf.js remote upload-save <id> (perf.js saves lists the local ones)`);
    for (const line of lines) {
        const [id, mb, text] = line.split('\t');
        const save = JSON.parse(text);
        console.log(`${id}  ${String(save.createdAt).slice(0, 16)}  ${mb} MB  ${save.name}`);
    }
}

function uploadSave(words, flags) {
    const s = settings(flags);
    const id = words[1];
    if (!id || !NAME.test(id)) throw new Error('Use: perf.js remote upload-save <id> (perf.js saves lists the local ones)');
    const local = path.join(Window.savesDir(flags), id);
    if (!fs.existsSync(path.join(local, 'save.json'))) throw new Error(`no save ${id} in ${path.relative(ROOT, Window.savesDir(flags))}`);
    if (remote(s, `[ -d "$B/saves/${id}" ] && echo yes || true`).stdout.trim() === 'yes') return say(`${id} is already on ${s.host}`);
    remote(s, `rm -rf "$B/saves/.${id}.pending"; mkdir -p "$B/saves"`);
    exec('scp', [...SSH, '-q', '-r', local, `${s.host}:${BASE}/saves/.${id}.pending`]);
    remote(s, `mv "$B/saves/.${id}.pending" "$B/saves/${id}"`);
    say(`${id} uploaded to ${s.host}`);
}

function main(words, flags) {
    const command = words[0];
    if (command === 'setup') return setup(flags);
    if (command === 'run') return run(flags);
    if (command === 'status') return printStatus(flags);
    if (command === 'pull') return pullJob(words, flags);
    if (command === 'saves') return printSaves(flags);
    if (command === 'upload-save') return uploadSave(words, flags);
    throw new Error('Use: perf.js remote setup | run --save=<id> [--ref=<a>,<b>] [run flags] | status | pull [<job>] | saves | upload-save <id>');
}

module.exports = { main };
