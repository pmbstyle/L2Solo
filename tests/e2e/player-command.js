'use strict';

// A player tells a bot beside him to hunt at a spot he names, and stays. The command is the bot
// brain's move_to_spot tool (BotAgentTools.applyMoveToSpot), which raises player_command on the
// bot: the named spot becomes its held earning answer (no search) and wakes its build, which the
// worker takes on the body's post; the body then walks to the spot. A perf world has no LLM, so the
// step calls the tool the way the brain does for the player's chat line ("hunt at <spot>"). Three
// bots are told, one every two minutes; the window's --minutes ends the run.
// Run: node scripts/perf.js run --save=<id> --scenario=script --script=tests/e2e/player-command.js --minutes=20 --keep-world

const GLUDIO = { locX: -12736, locY: 122816, locZ: -3112 };
// A bot this close to the player is one he talks to.
const NEAR = 1500;
const COMMANDS = 3;

module.exports = {
    name: 'player-command',
    players: 1,
    areas: ['GameServer/Bot/AI/BotAgentTools.js', 'GameServer/Bot/AI/DecisionEvents.js', 'GameServer/Bot/AI/BotDecisionService.js',
        'GameServer/Bot/Economy/EquipmentIncomeRoute.js', 'GameServer/Bot/Situations.js'],
    needs: { towns: ['Gludio'] },
    place() {
        return invoke('GameServer/World/TownRespawn').getClosestTown(GLUDIO.locX, GLUDIO.locY, GLUDIO.locZ) || GLUDIO;
    },

    async run({ player, step, within, world, setup }) {
        const World = invoke('GameServer/World/World');
        const Tools = invoke('GameServer/Bot/AI/BotAgentTools');
        const Events = invoke('GameServer/Bot/AI/DecisionEvents');
        const Spots = invoke('GameServer/Bot/AI/SpotService');
        const told = new Set();
        const crowd = await step('a crowd of cold hunters exists', () => {
            const place = world.crowd();
            if (!place || place.bots < 2) throw new Error(`no crowd of 2+ cold hunters (${JSON.stringify(place)})`);
            return place;
        });
        await step('the player arrives at the crowd', async () => {
            if (setup.teleport(player, crowd) === false) throw new Error('teleport refused');
            await within(10000, () => Math.hypot(player.loc().locX - crowd.locX, player.loc().locY - crowd.locY) < 500,
                { what: 'the player at the crowd' });
        });
        for (let n = 1; n <= COMMANDS; n++) {
            // A solo hunter's body beside the player, not yet told.
            const bot = await step(`a hunter beside the player (${n})`, () => within(120000, () => {
                const state = world.botsNear(player.loc(), NEAR).find(row => row.phase === 'hot' && row.activity === 'hunting'
                    && !row.party?.partyId && !told.has(row.characterId));
                const session = state && World.registeredActorById?.(state.characterId)?.session;
                return session?.actor && !session.partyCompanion ? { state, session } : null;
            }, { everyMs: 2000, what: 'a hot solo hunter within 1500 of the player' }));
            told.add(bot.state.characterId);
            // Another spot for its level, the nearest to it.
            const here = bot.state.loc, level = Number(bot.session.actor.fetchLevel());
            const current = String(Spots.findCurrentSpot(here)?.id ?? bot.state.spotId ?? '');
            const spot = Spots.ensureIndexed().filter(row => !row.raidBoss && String(row.id) !== current && Spots.isSuitable(row, level))
                .sort((a, b) => Math.hypot(a.center.locX - here.locX, a.center.locY - here.locY) - Math.hypot(b.center.locX - here.locX, b.center.locY - here.locY))[0];
            if (!spot) throw new Error(`no other spot for a level ${level} hunter`);
            await step(`the player tells it to hunt at ${spot.id} (${n})`, async () => {
                const outcome = await Tools.execute(bot.session, { action: 'move_to_spot', spotId: String(spot.id), confidence: 1 }, [player.session],
                    { playerSession: player.session, channel: 'local_chat', deferReply: true });
                if (!outcome?.applied) throw new Error(`the command was refused: ${outcome?.reason}`);
            });
            await step(`the worker answers: the named spot is its held answer (${n})`, () => within(60000, () =>
                !bot.session.nearRaise?.commandSeq && String(Events.statsFor(bot.session).earning?.spotId) === String(spot.id),
            { everyMs: 1000, what: `the command answered with ${spot.id} held` }));
            await new Promise(resolve => setTimeout(resolve, 120000));
        }
        await step('the player stays online', () => new Promise(() => {}));
    }
};
