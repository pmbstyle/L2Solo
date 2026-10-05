const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Policy = require('../src/GameServer/ClanHall/Policy');
const Runtime = require('../src/GameServer/ClanHall/Runtime');
const NpcUi = require('../src/GameServer/ClanHall/Npc');
const World = invoke('GameServer/World/World');
const SkillModel = invoke('GameServer/Model/Skill');
const supports = require('../data/ClanHalls/support.json');
const originalInvoke = global.invoke,
    originalFetch = World.fetchNpc;
const definition = Policy.definition(36),
    managerId = definition.managerIds[0];
let actorClan = 1,
    location = { ...definition.spawn },
    mp = 1000,
    mutations = 0,
    effect = null,
    teleported = null,
    revived = null;
const packets = [];
const rows = Policy.catalog.halls.map((h) => ({
    ...h,
    ownerId: h.id === 36 ? 1 : 0,
    auctionEndsAt: Date.UTC(2026, 8, 20, 14, 35),
    rentDueAt: Date.now() + Policy.WEEK,
    serviceDueAt: Date.now() + Policy.DAY,
    functionsJson: h.id === 36 ? '{"support":8}' : '{}'
}));
Runtime.applyRows(rows);
const npc = {
    fetchId: () => 100,
    fetchSelfId: () => managerId,
    fetchLocX: () => definition.spawn.locX,
    fetchLocY: () => definition.spawn.locY,
    fetchLocZ: () => definition.spawn.locZ,
    fetchMp: () => mp,
    setMp: (value) => {
        mp = value;
    }
};
const session = {
    activeNpcTalk: { selfId: managerId, objectId: 100 },
    actor: {
        fetchId: () => 1,
        fetchClanId: () => actorClan,
        fetchLocX: () => location.locX,
        fetchLocY: () => location.locY,
        fetchLocZ: () => location.locZ,
        isDead: () => false
    },
    dataSendToMe: (p) => packets.push(p)
};
World.fetchNpc = async () => npc;
global.invoke = (name) => {
    if (name === 'Database')
        return {
            fetchClanHallAuctions: async () => rows,
            configureClanHall: async () => {
                mutations++;
                return { ok: true };
            },
            placeClanHallBid: async () => {
                mutations++;
                return { ok: true };
            }
        };
    if (name === 'GameServer/Network/Response')
        return {
            npcHtml: (_, html) => ({ html }),
            actionFailed: () => ({ failed: true }),
            userInfo: () => ({ info: true })
        };
    if (name === 'GameServer/Actor/Generics/TeleportTo')
        return (_session, _actor, coords) => {
            teleported = coords;
        };
    if (name === path.actor)
        return {
            revive: (_session, _actor, options) => {
                revived = options;
            },
            teleportTo: (_session, _actor, coords) => {
                teleported = coords;
            }
        };
    if (name === 'GameServer/Skills/C4SkillEffects')
        return {
            execute: (_session, caster, target, skill) => {
                effect = { caster, target, skill };
            }
        };
    return originalInvoke(name);
};
async function main() {
    try {
        for (const buffs of Object.values(supports))
            for (const buff of buffs) {
                const data = DataCache.skills.find((s) => s.selfId === buff.id),
                    level = data?.levels.find((l) => l.level === buff.level);
                assert(data && level, `missing support skill ${buff.id}:${buff.level}`);
                assert(
                    new SkillModel({ ...utils.crushOb(data), ...level }).fetchSemantic().effect,
                    `unsupported hall buff ${buff.id}`
                );
            }
        for (const h of Policy.catalog.halls) {
            assert(
                Policy.inside(h, {
                    fetchLocX: () => h.spawn.locX,
                    fetchLocY: () => h.spawn.locY,
                    fetchLocZ: () => h.spawn.locZ
                })
            );
            for (const id of h.managerIds)
                assert(
                    DataCache.npcs.some((n) => n.selfId === id),
                    `missing manager ${id}`
                );
        }
        await NpcUi.render(session);
        assert(packets.find((p) => p.html)?.html.includes('Support magic'));
        assert(packets.find((p) => p.html)?.html.includes(' UTC'), 'rent date shows its timezone');
        npc.fetchSelfId = () => Policy.catalog.auctioneerIds[0];
        session.activeNpcTalk.selfId = npc.fetchSelfId();
        await NpcUi.render(session, ['clan-hall', 'view', '31']);
        assert(packets.filter((p) => p.html).at(-1).html.includes('Ends: 20 Sept 2026, 14:35 UTC'),
            'auction date is readable and uses an explicit timezone');
        npc.fetchSelfId = () => managerId;
        session.activeNpcTalk.selfId = managerId;
        assert(
            packets.every((p) => !p.html || p.html.length < 4000),
            'C4 dialogs must fit the HTML packet'
        );
        await NpcUi.handle(session, ['clan-hall', 'buff', '1086']);
        assert.equal(effect.skill.fetchLevel(), 1, 'hall haste is level one, not the generic level-two buffer');
        assert.strictEqual(effect.caster, npc);
        assert.strictEqual(effect.target, session.actor);
        assert.equal(mp, 1000, 'manager support does not consume MP');
        effect = null;
        await NpcUi.handle(session, ['clan-hall', 'buff', '1217']);
        assert.equal(effect, null, 'arbitrary skills cannot be requested');
        actorClan = 2;
        await NpcUi.handle(session, ['clan-hall', 'set', 'hp', '80']);
        assert.equal(mutations, 0, 'outsiders cannot configure another hall');
        await NpcUi.handle(session, ['clan-hall', 'buff', '1086']);
        assert.equal(effect, null, 'outsiders cannot use support');
        actorClan = 1;
        location = { locX: 0, locY: 0, locZ: 0 };
        await NpcUi.handle(session, ['clan-hall', 'set', 'hp', '80']);
        assert.equal(mutations, 0, 'stale NPC context cannot authorize remote purchases');
        location = { ...definition.spawn };
        session.activeNpcTalk.selfId = 123;
        assert.equal(await NpcUi.validNpc(session), null, 'unrelated NPC context must be rejected');
        const effects = originalInvoke('GameServer/Skills/C4SkillEffects');
        const escapeData = DataCache.skills.find((s) => s.selfId === 2040);
        const escape = new SkillModel({ ...utils.crushOb(escapeData), ...escapeData.levels[0] });
        session.actor.session = session;
        let dead = false;
        session.actor.isDead = () => dead;
        session.actor.state = { fetchDead: () => dead };
        assert(effects.execute(session, session.actor, session.actor, escape).recalled);
        assert.deepEqual(teleported, definition.spawn, 'hall scroll uses the owned hall destination');
        rows.find((h) => h.id === 36).functionsJson = '{"exp":50}';
        Runtime.applyRows(rows);
        dead = true;
        const restart = require('../src/GameServer/Network/Request/RestartPoint');
        restart.consume(session, { location: 1 });
        assert.equal(revived.restoreExpPercent, 50);
        assert.deepEqual(teleported, definition.spawn, 'hall restart uses the owned hall destination');
        Runtime.applyRows([]);
        revived = null;
        teleported = null;
        restart.consume(session, { location: 1 });
        assert.equal(revived, null, 'lost ownership rejects a stale hall restart');
        dead = false;
        // Decided 2026-10-05 (V13): as in C4, without an owned hall the scroll
        // goes to the town by the region rule instead of doing nothing.
        session.actor.fetchKarma = () => 0;
        assert.equal(effects.execute(session, session.actor, session.actor, escape).recalled, true);
        assert.deepEqual(teleported, invoke('GameServer/World/TownRespawn').restartCoords(session.actor),
            'lost ownership sends a hall scroll to the town restart point');
        for (const hall of Policy.catalog.halls) {
            for (const managerId of hall.managerIds) {
                const manager = DataCache.npcs.find(n => n.selfId === managerId);
                const allSpawns = DataCache.npcSpawns.flatMap(g => g.spawns);
                const locations = allSpawns.filter(s => s.selfId === managerId).flatMap(s => s.coords);
                assert.equal(locations.length, 1, `manager ${managerId} must have one spawn`);
                const aliases = new Set(DataCache.npcs.filter(n => n.selfId !== managerId
                    && n.template.name === manager.template.name).map(n => n.selfId));
                for (const spawn of allSpawns.filter(s => aliases.has(s.selfId))) {
                    for (const point of spawn.coords) {
                        const samePlace = locations.some(location => Math.hypot(
                            point.locX - location.locX, point.locY - location.locY
                        ) < 150 && Math.abs(point.locZ - location.locZ) < 150);
                        assert(!samePlace, `${manager.template.name}: legacy NPC ${spawn.selfId} overlaps manager ${managerId}`);
                    }
                }
            }
            assert(hall.doormanIds.length, `missing doorman for ${hall.id}`);
            for (const id of hall.doormanIds) {
                assert(NpcUi.handles(id));
                assert(DataCache.npcs.some(n => n.selfId === id), `missing doorman template ${id}`);
                const spawns = DataCache.npcSpawns.flatMap(g => g.spawns).filter(s => s.selfId === id);
                assert.equal(spawns.length, 1, `doorman ${id} must not be spawned twice`);
            }
        }
        Runtime.applyRows(rows);
        npc.fetchSelfId = () => 7787;
        npc.fetchName = () => 'Latif';
        session.activeNpcTalk.selfId = 7787;
        await NpcUi.render(session);
        let html = packets.filter(p => p.html).at(-1).html;
        assert(html.includes('Ruby Hall') && html.includes('has no owner'));
        assert(html.includes('Your clan hall: Aden') && html.includes('The Golden Chamber'));
        assert(!html.includes('quest'), 'doormen never open the unrelated quest fallback');
        rows.find(h => h.id === 25).ownerId = 2;
        Runtime.applyRows(rows);
        await NpcUi.render(session);
        html = packets.filter(p => p.html).at(-1).html;
        assert(html.includes('Only members of the owning clan'));
        actorClan = 2;
        await NpcUi.render(session);
        html = packets.filter(p => p.html).at(-1).html;
        assert(html.includes('belongs to your clan') && html.includes('Clan Hall Manager inside'));
        const beforeMutations = mutations;
        effect = null;
        teleported = null;
        for (const parts of [['set', 'hp', '80'], ['buff', '1086'], ['bid', '31', '9000000'], ['leave']])
            await NpcUi.handle(session, ['clan-hall', ...parts]);
        assert.equal(mutations, beforeMutations, 'doormen do not accept manager or auction commands');
        assert.equal(effect, null);
        assert.equal(teleported, null);
        console.log('Clan hall NPC authorization, data, buff levels, recall and restart checks passed');
    } finally {
        global.invoke = originalInvoke;
        World.fetchNpc = originalFetch;
        Runtime.applyRows([]);
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
