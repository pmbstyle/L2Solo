// C4 quest 501 data: L2J Lisvus fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975.
// Player participants deliberately have no character-level requirement.
const NPC = Object.freeze({ rodemai: 7756, altar: 7757, athrea: 7758, kalis: 7759 });
const HERBS = Object.freeze([
    { npcId: 685, itemId: 3833, name: 'Herb of Vanor', area: 'Plains of Glory' },
    { npcId: 644, itemId: 3832, name: 'Herb of Harit', area: 'Forest of Mirrors' },
    { npcId: 576, itemId: 3834, name: 'Herb of Oel Mahum', area: 'Outlaw Forest' }
]);
const ITEMS = Object.freeze({ 3832: 'Herb of Harit', 3833: 'Herb of Vanor', 3834: 'Herb of Oel Mahum',
    3835: 'Blood of Eva', 3837: 'Symbol of Loyalty', 3872: 'Antidote Recipe', 3873: 'Voucher of Faith', 3874: 'Proof of Alliance' });
const CHEST_LOCS = [[102273,103433,-3512],[102190,103379,-3524],[102107,103325,-3533],[102024,103271,-3500],
    [102327,103350,-3511],[102244,103296,-3518],[102161,103242,-3529],[102078,103188,-3500],
    [102381,103267,-3538],[102298,103213,-3532],[102215,103159,-3520],[102132,103105,-3513],
    [102435,103184,-3515],[102352,103130,-3522],[102269,103076,-3533],[102186,103022,-3541]];
module.exports = { NPC, HERBS, ITEMS, CHEST_LOCS, DROP_CHANCE: 0.35, BOT_LEVEL: 60, BOT_GAME_MINUTES: 30,
    INTERACTION_RADIUS: 250, SP_COST: 1400000, SP_REWARD: 120000 };
