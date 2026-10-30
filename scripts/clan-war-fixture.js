#!/usr/bin/env node
'use strict';
// Always copies the source through SQLite's backup API. Only the new copy
// receives synthetic hostility/evidence; no live writer or server is started.
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const Social = require('../src/GameServer/Clan/ClanSocialPolicy');
const args = process.argv.slice(2), value = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
async function main() {
    const sourcePath = value('--source'), outputPath = value('--out');
    if (!sourcePath || !outputPath) throw Error('Usage: node scripts/clan-war-fixture.js --source WORLD.sqlite --out NEW.sqlite [--from CLAN --to CLAN --hostility 45]');
    const sourceFile = path.resolve(sourcePath), outputFile = path.resolve(outputPath);
    if (sourceFile === outputFile || fs.existsSync(outputFile)) throw Error('The output must be a new database, different from the source');
    const hostility = Number(value('--hostility') || 45);
    if (!Number.isFinite(hostility) || hostility < 35 || hostility > 100) throw Error('Hostility must be between 35 and 100');
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    let pair;
    try {
        const clans = source.prepare(`SELECT c.id,c.name,c.level,c.leaderId,COUNT(p.id) AS members FROM clans c
            LEFT JOIN characters p ON p.clanId=c.id GROUP BY c.id`).all();
        const eligible = new Map(clans.filter(c => c.level >= 3 && c.members >= 15).map(c => [c.id, c]));
        const from = value('--from'), to = value('--to'), candidates = [], at = Date.now();
        for (const row of source.prepare('SELECT clanId,snapshotJson FROM clan_social_memory').all()) {
            const clan = eligible.get(row.clanId);
            if (!clan || from && clan.name.toLowerCase() !== from.toLowerCase()) continue;
            const snapshot = JSON.parse(row.snapshotJson);
            for (const relation of snapshot.relations) {
                const target = eligible.get(relation.targetId);
                if (relation.kind !== 'clan' || !target || to && target.name.toLowerCase() !== to.toLowerCase()) continue;
                candidates.push({ clan, target, snapshot, relation, score: Social.relation(relation, at).hostility });
            }
        }
        pair = candidates.sort((a, b) => b.score - a.score)[0];
        if (!pair) throw Error('No eligible recorded clan pair matches the requested names');
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        await backup(source, outputFile);
    } finally { source.close(); }
    const copy = new DatabaseSync(outputFile);
    try {
        copy.exec('BEGIN IMMEDIATE');
        const original = copy.prepare('SELECT snapshotJson FROM clan_social_memory WHERE clanId=?').get(pair.clan.id).snapshotJson;
        const snapshot = JSON.parse(original), relation = snapshot.relations.find(r => r.kind === 'clan' && r.targetId === pair.target.id);
        const subjects = copy.prepare('SELECT id FROM characters WHERE clanId=? ORDER BY id LIMIT 3').all(pair.target.id);
        const at = Date.now();
        relation.hostility = hostility; relation.at = at; relation.stance = 'hostile'; relation.halfLife = 7 * Social.DAY;
        relation.evidence = subjects.map((s, n) => ({ episode: `war-fixture:${at}:${n}`, category: 'harm',
            subject: s.id, subjectClanId: pair.target.id, witness: pair.clan.leaderId,
            at: at - (n + 1) * 60000, severity: 6, weight: 2 }));
        snapshot.revision++;
        copy.prepare('UPDATE clan_social_memory SET snapshotJson=?,updatedAt=? WHERE clanId=?').run(JSON.stringify(snapshot), at, pair.clan.id);
        copy.exec('COMMIT');
        const metadata = { source: sourceFile, database: outputFile, createdAt: new Date(at).toISOString(),
            from: pair.clan, to: pair.target, originalHostility: pair.score, testHostility: hostility,
            originalSnapshot: JSON.parse(original) };
        fs.writeFileSync(`${outputFile}.fixture.json`, JSON.stringify(metadata, null, 2));
        const { originalSnapshot, ...summary } = metadata;
        console.log(JSON.stringify(summary, null, 2));
    } finally { copy.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
