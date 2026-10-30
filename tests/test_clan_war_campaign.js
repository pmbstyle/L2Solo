const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Clans = invoke('GameServer/Clan/ClanService'), War = invoke('GameServer/Clan/ClanWarRuntime');
const Social = invoke('GameServer/Clan/ClanSocialRuntime');
const Conflict = require('../src/GameServer/Bot/Population/ColdPartyConflict');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const Policy = require('../src/GameServer/Clan/ClanWarPolicy');
const Config = require('../src/GameServer/Clan/ClanWarConfig');
const SocialPolicy = require('../src/GameServer/Clan/ClanSocialPolicy');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-war-campaign-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
let at = Date.now(), director;
const traits = { assertiveness: 1, commitment: 1, ambition: 1, caution: 0, empathy: 0, sociability: 1 };
const personaFor = () => ({ traits });
const state = id => Life.cachedState(id);
const base = { life: Life, owner: Owner, parties: Parties, memory: Memory, personaFor,
    participantAllowed: () => true, contestContextAllowed: () => true, onState() {}, now: () => at,
    pvpEnabled: () => true, waitMs: 1000, cooldownMs: 15000, rng: () => 0.1 };
function event(key) {
    const participant = id => { const s = state(id), p = Parties.find(s.party.partyId);
        return { id, revision: s.simulation.revision, memoryRevision: Memory.revision(id), partyId: p.partyId,
            partyRevision: p.revision, size: p.memberIds.length }; };
    return { key, at, action: 'clan_war', pvpIntent: true, pressure: 3, spotId: 'test', npcId: 0,
        actor: participant(1), peer: participant(16) };
}
async function party(ids) {
    const prepared = Parties.prepareCommit({ partyId: `war-test-${ids[0]}`, leaderId: ids[0], memberIds: ids,
        spotId: 'test', startedAt: at, status: 'active', nextResolveAt: at + 30000,
        stats: ids[0] === 1 ? { warOperation: { id: 'operation-1', clanId: 10, enemyClanId: 20 } } : {} });
    const assigned = ids.map(id => Life.preparePartyAssignment(state(id), prepared.row.partyId, 'dps', ids[0], at + 30000));
    const result = await DB.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
    assert(result.ok, result.reason); Life.acceptPartyAssignments(assigned, result.lifeRows); return Parties.acceptRow(result.partyRow);
}
async function run() {
    invoke('GameServer/DataCache').init(); DB.init();
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('bot_war_campaign','test')"]);
    for (let id = 1; id <= 31; id++) {
        const clanId = id <= 15 ? 10 : id <= 30 ? 20 : 0;
        const strong = clanId === 10;
        const stats = { clanId, classId: 0, generatedCold: true,
            ...([2, 3].includes(id) ? { marketReturn: { spotId: 'old-farm', loc: { locX: 1, locY: 2, locZ: 3 } } } : {}),
            coldCombat: { version: 1, classId: 0, cp: 0, cpAt: at,
                base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
                equipment: { weaponKind: 'Weapon.Sword', pAtk: strong ? 5000 : 1, pAtkRnd: 0, mAtk: 0,
                    atkSpd: 600, critical: 0, accur: 0, pDef: 100, mDef: 100, evasion: 0 },
                skills: [{ selfId: 1, level: 1, passive: true }] } };
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
            VALUES (?,'bot_war_campaign',?,0,0,40,1000,1000,500,500,0,0,0,0,50000,15000,-5000,?)`, [id, `WarFighter${id}`, clanId]]);
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            locX,locY,locZ,nextResolveAt,lastResolvedAt,updatedAt,statsJson)
            VALUES (?,'bot_war_campaign',?,'cold','hunting','test',1000,1000,500,500,40,50000,15000,-5000,?,?,?,?)`,
        [id, `WarFighter${id}`, at + 30000, at - 30000, at, JSON.stringify(stats)]]);
    }
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'CampaignA',1,3),(20,'CampaignB',16,3)"]);
    for (const clanId of [10, 20]) await DB.execute([`INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson)
        VALUES (?,1,'autonomous',?,?,?)`, [clanId, at, at, JSON.stringify({ clanId })]]);
    const social = SocialPolicy.empty(10);
    social.revision = 1;
    social.relations = [{ kind: 'clan', targetId: 20, at, halfLife: 7 * SocialPolicy.DAY,
        trust: -20, hostility: 45, fear: 0, familiarity: 5, reasons: [],
        evidence: [1, 2, 3].map(n => ({ episode: `war-test-${n}`, category: 'harm', subject: 15 + n,
            subjectClanId: 20, witness: 1, at: at - n * 60000, severity: 6, weight: 2 })) }];
    await DB.execute(['INSERT INTO clan_social_memory(clanId,snapshotJson,updatedAt) VALUES (?,?,?)', [10, JSON.stringify(social), at]]);
    assert(Policy.grievance(social.relations[0], traits, at, Config).ready);
    assert(!Policy.grievance({ ...social.relations[0], evidence: social.relations[0].evidence.slice(0, 1) }, traits, at, Config).ready);
    await Life.init(); await Parties.init(); await Clans.reload(); await Social.refresh(true);
    await Memory.ensureMany(Array.from({ length: 31 }, (_, i) => i + 1));
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const priorActions = Coordinator.competitionActions;
    try {
        Population.started = true;
        Coordinator.competitionActions = { canRun: () => !DB.pending(), apply: async () => ({ ok: true }) };
        await Population.startClanWars();
        await new Promise(resolve => setImmediate(resolve));
        assert(Population.clanWars.active, 'native population startup must start the military director');
        assert.strictEqual(Population.clanWars.memory, Memory, 'native startup supplies the shared memory owner');
        assert(Population.clanWars.canWork(), 'the real admission callback must be callable after startup');
        assert.equal(Population.clanWars.states.size, 31);
        const started = Population.clanWars;
        await Population.startClanWars();
        assert.strictEqual(Population.clanWars, started, 'duplicate startup does not attach a second publication subscriber');
        started.personaFor = personaFor;
        await started.review(Clans.findById(10), Date.now());
        assert(War.view.between(10, 20).outgoing,
            'a declaration admitted with an idle writer must not reject itself once its own transaction is pending');
        const transition = DB.transitionClanWar;
        try {
            DB.transitionClanWar = function (...args) { Population.started = false; return transition.apply(this, args); };
            await started.review(Clans.findById(20), Date.now());
            assert(!War.view.between(10, 20).mutual, 'shutdown still revokes a diplomatic command before its impact');
        } finally { DB.transitionClanWar = transition; Population.started = true; }
    } finally {
        Population.clanWars?.stop(); Population.clanWars = null; Population.started = false;
        Coordinator.competitionActions = priorActions;
    }
    director = new ClanWarDirector({ database: DB, life: Life, parties: Parties, clans: Clans, war: War,
        social: Social.view, memory: Memory, personaFor, form: async () => null, actions: { apply: async () => ({ ok: true }) }, now: () => at });
    await director.start(); await new Promise(resolve => setImmediate(resolve)); at = Date.now();
    const responderPlan = director.plans.get(20);
    if (responderPlan) responderPlan.nextReviewAt = 0;
    assert.equal(director.states.size, 31, 'director hydrates its event-driven spatial index');
    await director.review(Clans.findById(10), at);
    assert.equal(War.view.between(10, 20).status, 'outgoing', 'three distinct grudges and a real sighting produce a declaration');
    assert(!Memory.assess({ id: 1 }, { id: 16 }, {}, at).diplomaticEnemy, 'one-sided war cannot grant hostile affiliation');
    await director.review(Clans.findById(20), at);
    assert(War.view.between(10, 20).mutual, 'responder can accept without an independent high hostility score');
    assert(Memory.assess({ id: 1 }, { id: 16 }, {}, at).diplomaticEnemy);
    const p = await party([1, 2, 3]); await party([16, 17, 31]);
    const defenderBefore = JSON.stringify(state(16));
    const staleReturnBefore = JSON.stringify(state(2));
    const staleOwner = { ...Owner, commitBatch: async entries => {
        const withdrawal = await DB.transitionClanWar({ actorId: 16, targetClanId: 10, action: 'withdraw' });
        assert(withdrawal.ok); War.accept(withdrawal.row);
        return Owner.commitBatch(entries);
    } };
    at = Date.now();
    const stale = await Conflict.apply({ ...base, owner: staleOwner, event: event('war-stale') });
    assert(!stale.ok, 'a withdrawal before impact refuses the entire battle commit');
    assert.equal(JSON.stringify(state(16)), defenderBefore, 'rejected war has no HP, XP or memory effects');
    assert.equal(JSON.stringify(state(2)), staleReturnBefore, 'a refused impact cannot clear even an obsolete market return');
    const renewed = await DB.transitionClanWar({ actorId: 16, targetClanId: 10, action: 'declare' }); War.accept(renewed.row);
    at = Date.now();
    for (const patch of [
        { activity: 'shopping' },
        { stats: { ...state(2).stats, travel: { arrivalAt: at + 10000 } } },
        { stats: { ...state(2).stats, partyMarketReturn: { warOperationId: 'operation-1', until: at + 10000 } } },
        { stats: { ...state(2).stats, tradeMeeting: { id: 'active-purchase' } } },
    ]) {
        const before = JSON.stringify(state(2));
        const refused = await Conflict.apply({ ...base, event: event('war-member-shopping'),
            life: { cachedState: id => id === 2 ? { ...state(id), ...patch } : state(id) } });
        assert(!refused.ok && !refused.pvp, 'a real market activity or supply ticket still prevents the battle');
        assert.equal(JSON.stringify(state(2)), before, 'refused market activity has no side effects');
    }
    const Resolver = require('../src/GameServer/Bot/Population/ColdPvpResolver');
    const sides = [1, 16].map(id => ({ principal: state(id), members: Parties.find(state(id).party.partyId).memberIds.map(state) }));
    const roles = new Map([[1, 'initiator'], [2, 'support'], [3, 'support'], [16, 'target'], [17, 'support'], [31, 'stand_aside']]);
    const combat = current => Resolver.resolve({ sides: current, roles, timestamp: at, openingSide: 0,
        personaFor, rng: () => 0.1, wars: War.view, war: true, key: 'war-stepped',
        step: { until: at + 1000, expiresAt: at + 15000, maxActions: 20 } });
    const first = combat(sides);
    assert(first.started && !first.ongoing && first.fighters.flatMap(f => f.kills).length === 1,
        'a stepped encounter ends on a casualty so hot handoff never materializes a dead fighter');
    const survivors = sides.map(side => ({ ...side, members: side.members.map(s => first.updates.get(s.characterId) || s),
        principal: side.members.map(s => first.updates.get(s.characterId) || s).find(s => s.vitals.hp > 0 && s.characterId !== 31) }));
    const followup = combat(survivors);
    assert(followup.started && followup.fighters.flatMap(f => f.kills).length === 1,
        'the campaign can engage the surviving tagged enemy while dead party members remain outside combat');
    const result = await Conflict.apply({ ...base, event: event('war-accepted') });
    assert(result.ok && result.pvp, JSON.stringify(result));
    assert.equal(state(2).stats.marketReturn, null, 'accepted war combat clears the present military member obsolete return');
    assert.equal(state(3).stats.marketReturn, null, 'another present military supporter uses the same rule');
    const persisted = await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN(2,3)']);
    assert(persisted.every(r => JSON.parse(r.statsJson).marketReturn === null), 'cleanup commits atomically with the battle');
    const kills = result.combat.fighters.flatMap(f => f.kills);
    assert.equal(kills.length, 2, 'war continues past the first casualty to the remaining tagged enemy');
    assert(kills.every(k => k.pvp), 'white mutual-war victims grant PvP without PK');
    assert.equal(state(31).vitals.hp, 1000, 'a neutral party companion is not a war target');
    await DB.flushJournals();
    const pressure = await DB.fetchClanWarPressure(20, at - 60000, at + 1);
    assert.equal(pressure[0].losses, 2, 'only the accepted cold battle reports its committed party casualties');
    assert.equal(pressure[0].victims, 2, 'preview resolutions and the refused stale impact report no deaths');
    const counts = await DB.execute(['SELECT SUM(pk) AS pk,SUM(karma) AS karma,SUM(pvp) AS pvp FROM characters']);
    assert.equal(counts[0].pk, 0); assert.equal(counts[0].karma, 0); assert.equal(counts[0].pvp, 2);
    const savedSocial = JSON.parse((await DB.execute(['SELECT snapshotJson FROM clan_social_memory WHERE clanId=20']))[0]?.snapshotJson || '{"relations":[]}');
    assert(!savedSocial.relations.some(r => r.discipline?.stage && r.discipline.stage !== 'clear'), 'lawful war cannot punish the defender clan members');
    const savedOwn = JSON.parse((await DB.execute(['SELECT snapshotJson FROM clan_social_memory WHERE clanId=10']))[0].snapshotJson);
    assert(!savedOwn.relations.some(r => r.discipline?.stage && r.discipline.stage !== 'clear'), 'lawful war cannot punish attacking clan members');
    const packet = invoke('GameServer/Network/Response').relationChanged;
    const subject = { fetchClanId: () => 20, fetchId: () => 16, fetchKarma: () => 0, fetchPvpFlag: () => 0 };
    assert(packet.relationFor(subject, { fetchClanId: () => 10 }) & 0x08000);
    assert(!(packet.relationFor(subject, { fetchClanId: () => 30 }) & 0x08000), 'war icons are viewer-specific');
    const plan = director.plans.get(10);
    assert(plan.intel.length && plan.intel.every(i => i.observerId), 'intel carries its actual local witness');
    const outside = { ...state(30), loc: { locX: 90000, locY: 90000, locZ: 5000 } };
    director.index(outside, 30);
    assert(!director.observe(Clans.findById(10), [], at).some(i => i.enemyIds.includes(30)), 'distant enemies are not visible from the server database');
    const World = invoke('GameServer/World/World'), oldLookup = World.registeredActorById, oldVisible = World.fetchVisibleUsers;
    const hot = (id, x) => ({ fetchId: () => id, fetchLocX: () => x, fetchLocY: () => 15000, fetchLocZ: () => -5000,
        fetchIsOnline: () => true, isDead: () => false });
    const observer = hot(1, 50000), visibleEnemy = hot(19, 50500);
    try {
        director.index({ ...state(1), phase: 'hot' }, 1);
        World.registeredActorById = id => id === 1 ? { actor: observer, session: { actor: observer } } : null;
        World.fetchVisibleUsers = () => [{ actor: visibleEnemy, coldLifeState: { spotId: 'test' } }];
        const oneObserver = { ...Clans.findById(10), members: [{ id: 1 }] };
        assert(director.observe(oneObserver, [], at).some(i => i.enemyIds.includes(19)), 'live actors supply actual visible sightings');
        World.fetchVisibleUsers = () => [];
        assert.equal(director.observe(oneObserver, [], at).length, 0, 'hot observation cannot consult invisible cached targets');
    } finally { World.registeredActorById = oldLookup; World.fetchVisibleUsers = oldVisible; }
    assert.equal(Policy.operationOutcome({ clanId: 10, expiresAt: at + 1 }, [state(1)], { mutual: false }, at), 'war_ended');
    await DB.close(); DB.init();
    assert((await DB.fetchClanWarPlans()).some(r => r.clanId === 10 && JSON.parse(r.stateJson).lastDecision.reason === 'repeated_clan_aggression'));
    assert.equal((await DB.fetchClanWars()).filter(r => r.active).length, 2);
    assert(Parties.find(p.partyId));
    console.log('Clan war campaign: raised hostility, witnessed declaration, optional acceptance, stale impact rollback, party combat, neutral immunity, PvP/PK, discipline, viewer masks and durable decisions passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    director?.stop(); await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
