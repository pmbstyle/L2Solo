'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState'), War = invoke('GameServer/Clan/ClanWarRuntime');
const Spots = invoke('GameServer/Bot/AI/SpotService'), Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Home = require('../src/GameServer/Bot/Population/ClanWarHome');
const Movement = require('../src/GameServer/Bot/Population/ClanWarMovement');
const NativeMove = require('../src/GameServer/Bot/AI/BotClanWarOperation');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const { finishPartyRouteTravelState } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-war-height-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
const at = Date.now();
const cases = [
    { name: 'Minions', clanId: 6000090, enemyClanId: 6000089, leaderId: 2006151,
        home: { id: '15_17', name: 'Hunter Gargoyle fields', center: { locX: 92311, locY: 106667, locZ: -3069 } },
        members: [[2006151, 92579, 106465, -1168], [2006807, 92490, 106671, -1152],
            [2006189, 92345, 106555, -1136], [2007492, 92527, 106445, -1160]] },
    { name: 'StrongHold', clanId: 6000089, enemyClanId: 6000090, leaderId: 2006702,
        home: { id: '17_-1', name: 'Hungry Corpse fields', center: { locX: 106474, locY: -2128, locZ: -3239 } },
        members: [[2006345, 106154, -2128, -3472], [2006702, 106442, -2162, -3408],
            [2006967, 106258, -2323, -3440], [2006608, 106355, -1896, -3384],
            [2007700, 106340, -1940, -3400], [2006164, 106408, -2041, -3400],
            [2006656, 106211, -2010, -3440], [2006963, 106513, -2063, -3384]] }
];
const target = { id: '29_-4', name: 'Doom Warrior fields', center: { locX: 179447, locY: -21411, locZ: -3184 } };
const original = { spots: Spots.spots, profiles: Profiles.cache };
const current = c => c.members.map(([id]) => Life.cachedState(id));
async function run() {
    // Read only the two installed region files needed by these live coordinates.
    for (const key of ['22_21', '23_17']) {
        const buffer = fs.readFileSync(path.join(Geo.getGeodataDir(), `${key}.l2j`));
        Geo.regions[key] = buffer; Geo[`index_${key}`] = Geo.buildOffsetIndex(buffer);
    }
    const manifest = path.join(Geo.getGeodataDir(), '.l2solo-geodata-manifest.json');
    const livePack = fs.existsSync(manifest)
        && JSON.parse(fs.readFileSync(manifest, 'utf8')).profile === 'c4-client-2026-10-26';
    invoke('GameServer/DataCache').init(); DB.init();
    Spots.spots = [...cases.map(c => c.home), target]; Profiles.cache = Spots.spots;
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('war_height_test','test')"]);
    for (const c of cases) {
        await DB.execute(['INSERT INTO clans(id,name,leaderId,level) VALUES (?,?,?,3)', [c.clanId, c.name, c.leaderId]]);
        await DB.execute(["INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson) VALUES (?,1,'autonomous',?,?,'{}')", [c.clanId, at, at]]);
        const grounded = Home.point({ homeSpotId: c.home.id, homeLoc: c.home.center });
        assert.notEqual(grounded.locZ, c.home.center.locZ, `${c.name} fixture must expose the ungrounded anchor`);
        for (const [id, x, y, liveZ] of c.members) {
            const z = Geo.getHeight(x, y, grounded.locZ);
            if (livePack) assert.equal(z, liveZ, `${c.name}: installed C4 geometry reproduces the observed arrival`);
            await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
                VALUES (?,'war_height_test',?,0,0,60,1000,1000,500,500,0,0,0,0,?,?,?,?)`, [id, `Height${id}`, x, y, z, c.clanId]]);
            await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,locX,locY,locZ,nextResolveAt,lastResolvedAt,updatedAt,statsJson)
                VALUES (?,'war_height_test',?,'cold','grouped',?,1000,1000,500,500,60,?,?,?,?,?,?,?)`,
                [id, `Height${id}`, c.home.id, x, y, z, at, at - 1000, at, JSON.stringify({ clanId: c.clanId })]]);
        }
    }
    await DB.execute(['INSERT INTO clan_war_declarations(fromClanId,toClanId,active,revision,declaredAt,updatedAt) VALUES (6000090,6000089,1,1,?,?),(6000089,6000090,1,2,?,?)', [at, at, at, at]]);
    await War.refresh(true); await Life.init(); await Parties.init();
    const director = new ClanWarDirector({ database: DB, life: Life, parties: Parties, war: War });
    const Travel = invoke('GameServer/Bot/AI/BotSpotTravel'), Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
    const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
    const saved = { start: Travel.start, stop: Tactics.stop, canUse: Restrictions.canUseBasicAction };
    try {
        Restrictions.canUseBasicAction = () => true; Tactics.stop = () => {};
        for (const c of cases) {
            const partyId = `height_return_${c.clanId}`;
            const op = { id: `height:${c.clanId}`, clanId: c.clanId, enemyClanId: c.enemyClanId,
                status: 'returning', targetSpotId: target.id, targetLoc: target.center,
                homeSpotId: c.home.id, homeLoc: c.home.center, expiresAt: at - 1 };
            const prepared = Parties.prepareCommit({ partyId, leaderId: c.leaderId,
                memberIds: c.members.map(([id]) => id), status: 'active', spotId: c.home.id,
                startedAt: at - 1000000, nextResolveAt: at, stats: { warOperation: op } });
            const assigned = current(c).map(s => Life.preparePartyAssignment(s, partyId, 'dps', 1, at));
            const commit = await DB.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
            assert(commit.ok, commit.reason); Life.acceptPartyAssignments(assigned, commit.lifeRows); Parties.acceptRow(commit.partyRow);
            await director.maintain(Parties.find(partyId), at);
            const home = Home.point(op), repaired = Parties.find(partyId);
            assert.deepEqual(repaired.stats.warOperation.homeLoc, home, `${c.name}: legacy height repair is durable`);
            const route = () => Movement.route({ leader: current(c).find(s => s.characterId === c.leaderId),
                party: Parties.find(partyId), members: current(c), spot: c.home, timestamp: at,
                spots: Spots.spots, wars: War.view });
            assert(!route().route, `${c.name}: the actual full roster has no repeated return trip`);
            for (const state of current(c)) {
                const actor = { fetchClanId: () => c.clanId, fetchLocX: () => state.loc.locX,
                    fetchLocY: () => state.loc.locY, fetchLocZ: () => state.loc.locZ, state: { fetchCasts: () => false } };
                const session = { actor };
                Travel.start = () => { throw Error('already arrived native member must not travel again'); };
                NativeMove.tick(session, actor, repaired, at);
                assert.equal(session.lastDecision.action, 'clan_war_home');
            }
            const member = current(c).at(-1);
            await Life.upsertState({ ...member, stats: { ...member.stats, travel: { arrivalAt: at + 25000 } } });
            await director.maintain(Parties.find(partyId), at + 1);
            assert(Parties.find(partyId).stats.warOperation, 'an in-flight member prevents completion');
            await Life.upsertState({ ...member, loc: { ...member.loc, locZ: member.loc.locZ + 2000 } });
            await director.maintain(Parties.find(partyId), at + 2);
            assert(Parties.find(partyId).stats.warOperation, 'a member on another floor prevents completion');
            const recovery = route().route;
            assert(recovery?.cause === 'clan_war_return', 'wrong-floor return still schedules a real trip');
            const traveling = current(c).map(s => beginHuntingTrip(s, recovery, at));
            const arrival = Math.max(...traveling.map(s => s.stats.travel.arrivalAt));
            const arrived = traveling.map(s => finishPartyRouteTravelState(s, arrival));
            assert(arrived.every(s => Home.reached(s.loc, home)), `${c.name}: actual geodata placement agrees with return verification`);
            for (const state of arrived) await Life.upsertState(state);
            assert(!route().route, 'one physical arrival is enough; no second trip is started');
            await director.maintain(Parties.find(partyId), arrival + 1);
            assert.equal(Parties.find(partyId).stats.warOperation, null, `${c.name}: the full physically returned roster closes the order`);
            console.log(`${c.name}: exact coordinates, grounded durable anchor, native/cold arrival, wrong-floor/in-flight guards and completed return passed`);
        }
    } finally { Travel.start = saved.start; Tactics.stop = saved.stop; Restrictions.canUseBasicAction = saved.canUse; }
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Spots.spots = original.spots; Profiles.cache = original.profiles;
    await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
