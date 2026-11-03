'use strict';

// A player in Gludio talks to the gatekeeper and takes a teleport, all through client packets:
// walk (0x01), click the NPC twice (0x04: target, then talk), click links in its window (0x21).
// Expected from the server: the NPC's window (NpcHtml); with no Adena the gatekeeper refuses ("You do not
// have enough Adena." and no teleport); given Adena, TeleportToLocation and the player far away.
// Run: node scripts/perf.js run --save=<id> --scenario=script --script=tests/e2e/gatekeeper.js --warmup=2

const GLUDIO = { locX: -12736, locY: 122816, locZ: -3112 };

module.exports = {
    name: 'gatekeeper',
    players: 1,
    // The town's restart point: TownRespawn keeps it 50 from the gatekeeper.
    place() {
        return invoke('GameServer/World/TownRespawn').getClosestTown(GLUDIO.locX, GLUDIO.locY, GLUDIO.locZ) || GLUDIO;
    },

    async run({ player, step, within, npcHtml, bypasses, carries, world, setup }) {
        const keeper = await step('a gatekeeper is near the player', () => within(10000, () =>
            world.npcsNear(player.loc(), 1500, npc => /gatekeeper/i.test(String(npc.fetchTitle?.() || '')))[0],
        { what: 'a gatekeeper within 1500' }));

        await step('the player walks up to it', async () => {
            await player.walk({ locX: keeper.fetchLocX() + 60, locY: keeper.fetchLocY(), locZ: keeper.fetchLocZ() });
            await within(15000, () => Math.hypot(player.loc().locX - keeper.fetchLocX(), player.loc().locY - keeper.fetchLocY()) < 200,
                { what: 'the player within 200 of the gatekeeper' });
        });

        const window = await step('two clicks open its window', async () => {
            const since = Date.now();
            await player.action(keeper.fetchId());
            await player.packet('MyTargetSelected', { since, timeoutMs: 5000 });
            await player.action(keeper.fetchId());
            return npcHtml(await player.packet('NpcHtml', { since, timeoutMs: 10000 }));
        });

        // The first window may list teleports or lead to them (a "Chat"/"teleport" page first).
        const teleportLink = await step('its window leads to a teleport', async () => {
            let links = bypasses(window.html);
            for (let page = 0; page < 3 && !links.some(link => /teleport\s+\d+/i.test(link)); page++) {
                const next = links.find(link => /teleport|chat/i.test(link));
                if (!next) break;
                const since = Date.now();
                await player.bypass(next);
                links = bypasses(npcHtml(await player.packet('NpcHtml', { since, timeoutMs: 8000 })).html);
            }
            const link = links.find(item => /teleport\s+\d+/i.test(item));
            if (!link) throw new Error(`no teleport link among: ${links.join(' | ')}`);
            return link;
        });

        await step('with no Adena the gatekeeper refuses', async () => {
            const since = Date.now(), from = player.loc();
            await player.bypass(teleportLink);
            await within(8000, () => player.received.some(entry => entry.at >= since && carries(entry, 'not have enough Adena')),
                { what: 'the "not enough Adena" line' });
            if (player.received.some(entry => entry.at >= since && entry.name === 'TeleportToLocation')) throw new Error('teleported without paying');
            if (Math.hypot(player.loc().locX - from.locX, player.loc().locY - from.locY) > 300) throw new Error('moved without paying');
        });

        await step('given Adena, the player has it', async () => {
            const since = Date.now();
            await setup.giveAdena(player, 100000);
            await player.packet('ItemsList', { since, timeoutMs: 5000 });
        });

        await step('the teleport moves the player far away', async () => {
            const since = Date.now(), from = player.loc();
            await player.bypass(teleportLink);
            await player.packet('TeleportToLocation', { since, timeoutMs: 10000 });
            await within(10000, () => Math.hypot(player.loc().locX - from.locX, player.loc().locY - from.locY) > 3000,
                { what: 'the player more than 3000 away' });
        });
    }
};
