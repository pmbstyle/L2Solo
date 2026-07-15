const CRYSTAL_D = 1458;
const CRYSTAL_C = 1459;

const c = (amount) => ({ selfId: CRYSTAL_C, amount, name: 'Crystal: C-Grade' });
const d = (amount) => ({ selfId: CRYSTAL_D, amount, name: 'Crystal: D-Grade' });
const item = (selfId, name, crystalC, crystalD) => ({
    result: { selfId, amount: 1, name },
    required: [c(crystalC), d(crystalD)]
});

const LISTS = {
    7097: [
        item(71, 'Flamberge', 573, 2865),
        item(72, 'Stormbringer', 573, 2865),
        item(76, 'Sword of Delusion', 1075, 5375),
        item(294, 'War Pick', 573, 2865),
        item(162, 'War Axe', 1075, 5375),
        item(192, 'Crystal Staff', 573, 2865),
        item(200, "Sage's Staff", 1075, 5375),
        item(226, 'Cursed Dagger', 573, 2865),
        item(233, 'Dark Screamer', 1075, 5375),
        item(263, 'Chakram', 573, 2865),
        item(265, 'Fisted Blade', 1075, 5375),
        item(281, 'Crystallized Ice Bow', 573, 2865),
        item(283, 'Akat Long Bow', 1075, 5375),
        item(298, 'Orcish Glaive', 573, 2865),
        item(95, 'Poleaxe', 1075, 5375)
    ],

    7098: [
        item(354, 'Chain Mail Shirt', 127, 635),
        item(381, 'Chain Gaiters', 79, 395),
        item(60, 'Composite Armor', 360, 1800),
        item(397, 'Mithril Shirt', 95, 475),
        item(2387, 'Tempered Mithril Gaiters', 59, 295),
        item(400, 'Theca Leather Armor', 207, 1035),
        item(420, 'Theca Leather Gaiters', 129, 645),
        item(439, 'Karmian Tunic', 95, 475),
        item(441, "Demon's Tunic", 184, 920),
        item(471, 'Karmian Stockings', 59, 295),
        item(472, "Demon's Stockings", 115, 575),
        item(2429, 'Chain Boots', 32, 160),
        item(568, 'Composite Boots', 62, 310),
        item(2452, 'Reinforced Mithril Gloves', 32, 160),
        item(608, 'Mithril Gauntlets', 62, 310),
        item(631, 'Eldarake', 34, 170),
        item(103, 'Tower Shield', 65, 325),
        item(852, 'Moonstone Earring', 39, 195),
        item(854, 'Earring of Binding', 74, 370),
        item(883, 'Aquastone Ring', 26, 130),
        item(885, 'Ring of Ages', 49, 245),
        item(915, 'Aquastone Necklace', 52, 260),
        item(917, 'Necklace of Mermaid', 99, 495)
    ]
};

const NPC_NAMES = {
    7097: 'Trader Galladucci',
    7098: 'Trader Alexandria'
};

function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function fetchForNpc(npcSelfId) {
    return LISTS[npcSelfId] || [];
}

function renderHtml(npcSelfId, message = '') {
    const rows = fetchForNpc(npcSelfId);
    const title = NPC_NAMES[npcSelfId] || 'Luxury Trader';
    const lines = [
        '<html><body>',
        `${esc(title)}:<br>`,
        'Luxury exchange goods:<br>'
    ];

    if (message) {
        lines.push(`<font color="LEVEL">${esc(message)}</font><br>`);
    }

    rows.forEach((row, index) => {
        const required = row.required.map((entry) => `${esc(entry.name)} x${entry.amount}`).join(', ');
        lines.push(`${esc(row.result.name)} - ${required} <a action="bypass -h exchange-shop buy ${index}">Exchange</a><br>`);
    });

    lines.push('<br><a action="bypass -h sell-shop">Sell items</a><br>');
    lines.push('</body></html>');
    return lines.join('');
}

module.exports = {
    fetchForNpc,
    renderHtml
};
