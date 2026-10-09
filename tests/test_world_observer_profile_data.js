const assert = require('node:assert/strict');
const { project } = require('../src/WorldObserver/ActorEconomyProjection');
const { createActorCollections } = require('../src/WorldObserver/ActorCollections');
const UI = require('../src/WorldObserver/public/profileData');
const itemFor = id => ({ selfId: id, name: id === 673 ? 'Avadon Shield' : `Item ${id}` });
const network = { decisionSeq: 7, activityLeaf: 123, activity: {
    rootKey: 'power:673:8', nodeKey: 'item:1872', activity: 'hunting', kind: 'drop', itemId: 1872,
    amount: 3, npcId: 1001, spotId: 'field', price: 100, effort: .5, requirements: new Array(1000).fill({ cost: 2 })
} };
const state = { adena: 1000, inventory: { 10: { selfId: 10, amount: 2, instances: [
    { id: 1, amount: 1, enchant: 0, equipped: true }, { id: 2, amount: 1, enchant: 5, equipped: false } ] } },
stats: { decisionSeq: 7, wishFocus: ['power:673:8', 12, 900],
    money: [100, .1, 30, 900, .3, 120, 673, .2, 300, 1872],
    acquisitionGoal: { status: 'active', target: { selfId: 673 }, next: { kind: 'drop', itemId: 673, raidBoss: true } },
    equipmentPlan: { status: 'deferred', reason: 'wish_focus' }, dormantWishes: [['stock:shots','superseded',0,20,11,.5]],
    coldPvp: { at: 0 }, pvpIncidents: [{ at: 1000, startedAt: 900, opponentId: 42, responsibility: 'defense', aggressionRole: 'provoked' }] } };
const economy = project(state, { itemFor, activity: network.activity });
assert.equal(economy.focus.item.name, 'Avadon Shield');
assert.deepEqual(economy.money.funded.map(row => row.cost), [120,180], 'cumulative protected costs must not be added twice');
assert.equal(economy.acquisitionGoal.target.selfId, 673);
assert.equal(economy.equipmentPlan.reason, 'wish_focus');
assert.equal(economy.selectedAction.root.item.selfId, 673);
assert.equal(economy.selectedAction.item.selfId, 1872, 'an input step must remain distinct from its desired product');
assert.ok(JSON.stringify(economy.selectedAction).length < 600, 'the full network must never enter an Observer response');
assert.equal(project(state, { itemFor }).selectedAction, null, 'a missing publication must not trigger a fresh economic choice');
assert.equal(state.stats.money[5], 120, 'inspection must not alter the saved allocation');
const henna = project({ ...state, stats: { wishFocus: ['henna:124', 1, 50] } }, { wishName: () => 'STR +4 · CON -4' });
assert.match(UI.renderEconomy(henna), /Install henna · STR \+4 · CON -4/);
assert.match(UI.renderEconomy(economy), /Avadon Shield/);
assert.match(UI.renderEconomy(economy), /Amounts are priorities only/);

(async () => {
    const queries = [];
    const list = createActorCollections({ subjectFor: async (_kind, id) => id === 1 ? { state } : null,
        itemFor, shopsFor: async () => [], enemiesFor: () => [], execute: async query => {
            queries.push(query);
            if (query[0].includes('COUNT(*)')) return [{ total: 142 }];
            if (query[0].includes('pvp, pk')) return [{ pvp: 1, pk: 0, karma: 0 }];
            return [{ id: 101, selfId: 673, amount: 2, enchant: 3 }];
        } });
    const inventory = await list('bot', 1, 'inventory');
    assert.deepEqual(inventory.rows.map(row => [row.amount, row.enchant, row.equipped]), [[1,0,true],[1,5,false]],
        'distinct enchanted instances must not be collapsed into the aggregate item count');
    assert.equal(queries.length, 0, 'cold inventory must come from the authoritative lifecycle state');
    const warehouse = await list('bot', 1, 'warehouse', { offset: 100, limit: 100 });
    assert.equal(warehouse.total, 142); assert.equal(warehouse.offset, 100); assert.equal(warehouse.rows[0].enchant, 3);
    assert.deepEqual(queries.find(query => query[0].includes('LIMIT'))[1], [1,100,100]);
    const pvp = await list('bot', 1, 'pvp');
    assert.equal(pvp.totals.pvp, 1, 'PvP must be available with developer diagnostics disabled');
    assert.equal(pvp.lastEncounter, null, 'an empty combat clock is not a completed encounter');
    assert.equal(pvp.incidents[0].responsibility, 'defense');
    assert.match(UI.renderCollection('pvp', pvp), /Defender[\s\S]*Against character #42/);
    const combatHtml = UI.renderCollection('pvp', { ...pvp, generatedAt: 1791554915038,
        lastEncounter: { at: 1790943012537, outcome: 'retreated' },
        enemies: [{ name: '<Messerheld>', kills: 1, attacks: 3, lastSeenAt: 1790506769091 }] }, { ownerName: '<Bic4kci>' });
    assert.match(combatHtml, /Opponents who attacked or killed &lt;Bic4kci&gt;/);
    assert.match(combatHtml, /&lt;Messerheld&gt;/);
    assert.match(combatHtml, /Deaths caused<\/dt><dd>1/);
    assert.match(combatHtml, /A side withdrew/); // The shared outcome cannot identify which side retreated.
    assert.match(combatHtml, /7 days ago/); // Fetch time is not the time of the saved encounter.
    assert.match(combatHtml, /attack records capped at 3/);
    assert.equal(await list('bot', 2, 'skills'), null);
    await assert.rejects(list('bot', 1, 'warehouse', { limit: 1000 }), /invalid_profile_collection/);
    await assert.rejects(list('bot', 1, 'warehouse', { offset: -1 }), /invalid_profile_collection/);
    const live = createActorCollections({ subjectFor: async () => ({ actor: { skillset: { fetchSkills: () => [{
        fetchSelfId: () => 12, fetchName: () => '<img onerror=x>', fetchLevel: () => 4, fetchPassive: () => false }] } } }),
        itemFor, execute: () => { throw Error('live skills must not query stale database data'); } });
    const skills = await live('player', 3, 'skills');
    assert.equal(skills.rows[0].level, 4);
    const html = UI.renderCollection('skills', skills);
    assert.ok(!html.includes('<img onerror=x>')); assert.match(html, /&lt;img/);
    assert.match(UI.renderCollection('warehouse', warehouse), /Next|Previous/);

    const fs = require('node:fs'), vm = require('node:vm');
    const app = fs.readFileSync(require.resolve('../src/WorldObserver/public/app.js'), 'utf8');
    const pending = [], browserState = { live: true, selectedId: { id: 1, kind: 'bot' },
        profileTab: 'inventory', profileCollections: {}, profileCollectionRequest: null };
    const browser = vm.createContext({ state: browserState, AbortController, Date,
        document: { hidden: false, body: { dataset: { view: 'profile' } } }, renderInspector() {},
        fetch: (url, { signal }) => new Promise((resolve, reject) => {
            pending.push({ url, resolve: data => resolve({ ok: true, json: async () => data }) });
            signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })));
        }) });
    vm.runInContext(app.slice(app.indexOf('function resetProfileCollections()'), app.indexOf('async function loadActorDetail(')), browser);
    const first = browser.loadProfileCollection();
    const second = browser.loadProfileCollection({ force: true });
    await first;
    assert.equal(browserState.profileCollections.inventory.loading, true,
        'an aborted earlier request cannot clear a replacement request loading state');
    pending[1].resolve({ section: 'inventory', rows: [], offset: 0 }); await second;
    browserState.profileTab = 'warehouse'; const cancelledTab = browser.loadProfileCollection();
    browserState.profileTab = 'skills'; const skillsTab = browser.loadProfileCollection(); await cancelledTab;
    assert.equal(browserState.profileCollections.warehouse.at, 0,
        'an aborted tab remains eligible for immediate loading when revisited');
    browser.resetProfileCollections(); browserState.selectedId = { id: 2, kind: 'bot' }; await skillsTab;
    assert.equal(Object.keys(browserState.profileCollections).length, 0,
        'an old actor response cannot populate another actor profile');
    const otherActor = browser.loadProfileCollection();
    assert.match(pending[4].url, /actor\/bot\/2\/skills/);
    pending[4].resolve({ section: 'skills', rows: [], offset: 0 }); await otherActor;
    browserState.live = false; browserState.profileTab = 'warehouse';
    await browser.loadProfileCollection(); assert.equal(pending.length, 5, 'paused profiles do not poll collections');
    const manual = browser.loadProfileCollection({ force: true });
    pending[5].resolve({ section: 'warehouse', rows: [], offset: 0 }); await manual;
    assert.ok(browserState.profileCollections.warehouse.data, 'a manual tab request still works while paused');
    console.log('Observer economy and profile collection checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
