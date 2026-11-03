'use strict';

// A player comes to a crowd of cold bots and leaves again. The population's own policy has to heat
// the bots near the player (cold -> hot through the handoff, the bots shown to the player: CharInfo)
// and cool them after the player has gone (hot -> cold after cooldownGraceMs, 120 s, beyond
// cooldownRadius, 11000), with their rows whole and no worker fault or afterCommit error on the way.
// Run: node scripts/perf.js run --save=<id> --scenario=script --script=tests/e2e/cold-hot-cold.js --warmup=2 --minutes=10

const GLUDIO = { locX: -12736, locY: 122816, locZ: -3112 };
const NEAR = 3000;
// Far enough from town that leaving it puts the crowd past cooldownRadius (11000).
const AWAY = 14000;

module.exports = {
    name: 'cold-hot-cold',
    players: 1,
    // The code this scenario plays (planning/architecture/e2e.md): a change there runs it.
    areas: ['GameServer/Bot/Population/PopulationService.js', 'GameServer/Bot/Population/HotActivation.js',
        'GameServer/Bot/Population/Cooldown.js', 'GameServer/Bot/Population/ActivationPlacement.js',
        'GameServer/Bot/Population/BotLifeState.js', 'GameServer/Bot/Population/ColdSimulationCoordinator.js',
        'GameServer/Bot/Population/PopulationConfig.js', 'GameServer/World/CharacterVisibility.js',
        'GameServer/Actor/Generics/TeleportTo.js'],
    needs: { towns: ['Gludio'] },
    place() {
        return invoke('GameServer/World/TownRespawn').getClosestTown(GLUDIO.locX, GLUDIO.locY, GLUDIO.locZ) || GLUDIO;
    },

    async run({ player, step, within, objectIdAt, world, setup }) {
        const before = world.failures();
        const town = player.loc();

        const crowd = await step('a crowd of cold hunters exists far from town', () => {
            const place = world.crowd({ awayFrom: town, beyond: AWAY });
            if (!place || place.bots < 2) throw new Error(`no crowd of 2+ cold hunters ${AWAY} from town (${JSON.stringify(place)})`);
            return place;
        });
        // The hunters there now: the ones this scenario follows, with their level to compare after.
        const followed = world.botsNear(crowd, NEAR).filter(state => state.phase === 'cold' && state.activity === 'hunting')
            .map(state => state.characterId);
        const levels = new Map(world.bots().filter(state => followed.includes(state.characterId)).map(state => [state.characterId, state.level]));
        if (followed.length < 2) throw new Error(`only ${followed.length} cold hunter(s) within ${NEAR} of the crowd`);
        const activationRadius = Number(invoke('GameServer/Bot/Population/PopulationConfig').activationRadius || 9000);

        const arrived = await step('the player arrives at the crowd', async () => {
            const since = Date.now();
            if (setup.teleport(player, crowd) === false) throw new Error('teleport refused');
            await within(10000, () => Math.hypot(player.loc().locX - crowd.locX, player.loc().locY - crowd.locY) < 500,
                { what: 'the player at the crowd' });
            return since;
        });

        const heated = await step('bots near the player become hot', () => within(60000, () => {
            const here = player.loc();
            const hot = followed.filter((id) => {
                const state = world.bots().find(row => row.characterId === id);
                return state?.phase === 'hot' && state.loc && Math.hypot(state.loc.locX - here.locX, state.loc.locY - here.locY) <= activationRadius;
            });
            return hot.length >= 2 ? hot : null;
        }, { everyMs: 1000, what: `2 of the ${followed.length} followed hunters hot near the player` }));

        await step('the hot bots are shown to the player', () => player.packet('CharInfo', { since: arrived, timeoutMs: 30000,
            match: entry => heated.includes(objectIdAt(entry, 19)) }));

        await step('the player leaves', async () => {
            if (setup.teleport(player, town) === false) throw new Error('teleport refused');
            await within(10000, () => Math.hypot(player.loc().locX - town.locX, player.loc().locY - town.locY) < 500,
                { what: 'the player back in town' });
        });

        await step('the bots cool once the player is gone', () => within(240000, () => {
            const still = heated.filter(id => world.bots().find(state => state.characterId === id)?.phase !== 'cold');
            return still.length === 0 ? true : null;
        }, { everyMs: 5000, what: `all ${heated.length} heated bots cold again` }));

        await step('their rows are whole and nothing failed', () => {
            for (const id of heated) {
                const state = world.bots().find(row => row.characterId === id);
                if (!state?.loc || !Number.isFinite(Number(state.loc.locX))) throw new Error(`bot ${id} has no location`);
                if (Number(state.level) < Number(levels.get(id))) throw new Error(`bot ${id} lost levels: ${levels.get(id)} -> ${state.level}`);
            }
            const after = world.failures();
            if (after.workerFaults > before.workerFaults) throw new Error(`${after.workerFaults - before.workerFaults} worker fault(s)`);
            if (after.afterCommitErrors > before.afterCommitErrors) throw new Error(`${after.afterCommitErrors - before.afterCommitErrors} afterCommit error(s)`);
        });
    }
};
