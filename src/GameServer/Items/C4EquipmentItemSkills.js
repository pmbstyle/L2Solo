// Generated from Lisvus/L2J C4 datapack XML: stats/items item_skill and stats/skills 3000-3699 ITEM_SA.
// Conditional stat children are preserved as metadata but not applied until the matching runtime predicate exists.

const EffectStore = invoke('GameServer/Effects/EffectStore');

const CATEGORY = 'equipment_item_skill';
const ITEM_SKILLS = {
    "4681": {
        "skillId": 3026,
        "level": 1,
        "name": "Stormbringer - Critical Anger",
        "kind": "Weapon"
    },
    "4682": {
        "skillId": 3010,
        "level": 1,
        "name": "Stormbringer - Focus",
        "kind": "Weapon"
    },
    "4684": {
        "skillId": 3007,
        "level": 2,
        "name": "Shamshir - Guidance",
        "kind": "Weapon"
    },
    "4685": {
        "skillId": 3018,
        "level": 2,
        "name": "Shamshir - Back Blow",
        "kind": "Weapon"
    },
    "4686": {
        "skillId": 3028,
        "level": 2,
        "name": "Shamshir - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4687": {
        "skillId": 3010,
        "level": 2,
        "name": "Katana - Focus",
        "kind": "Weapon"
    },
    "4688": {
        "skillId": 3023,
        "level": 2,
        "name": "Katana - Critical Damage",
        "kind": "Weapon"
    },
    "4689": {
        "skillId": 3037,
        "level": 2,
        "name": "Katana - Haste",
        "kind": "Weapon"
    },
    "4690": {
        "skillId": 3023,
        "level": 2,
        "name": "Spirit Sword - Critical Damage",
        "kind": "Weapon"
    },
    "4692": {
        "skillId": 3037,
        "level": 2,
        "name": "Spirit Sword - Haste",
        "kind": "Weapon"
    },
    "4693": {
        "skillId": 3010,
        "level": 2,
        "name": "Raid Sword - Focus",
        "kind": "Weapon"
    },
    "4696": {
        "skillId": 3007,
        "level": 3,
        "name": "Caliburs - Guidance",
        "kind": "Weapon"
    },
    "4697": {
        "skillId": 3010,
        "level": 3,
        "name": "Caliburs - Focus",
        "kind": "Weapon"
    },
    "4698": {
        "skillId": 3023,
        "level": 3,
        "name": "Caliburs - Critical Damage",
        "kind": "Weapon"
    },
    "4699": {
        "skillId": 3010,
        "level": 3,
        "name": "Sword of Delusion - Focus",
        "kind": "Weapon"
    },
    "4700": {
        "skillId": 3013,
        "level": 1,
        "name": "Sword of Delusion - Health",
        "kind": "Weapon"
    },
    "4701": {
        "skillId": 3032,
        "level": 3,
        "name": "Sword of Delusion - Rsk. Haste",
        "kind": "Weapon"
    },
    "4702": {
        "skillId": 3010,
        "level": 3,
        "name": "Tsurugi - Focus",
        "kind": "Weapon"
    },
    "4703": {
        "skillId": 3023,
        "level": 3,
        "name": "Tsurugi - Critical Damage",
        "kind": "Weapon"
    },
    "4704": {
        "skillId": 3037,
        "level": 3,
        "name": "Tsurugi - Haste",
        "kind": "Weapon"
    },
    "4705": {
        "skillId": 3013,
        "level": 1,
        "name": "Sword of Nightmare - Health",
        "kind": "Weapon"
    },
    "4706": {
        "skillId": 3010,
        "level": 3,
        "name": "Sword of Nightmare - Focus",
        "kind": "Weapon"
    },
    "4708": {
        "skillId": 3010,
        "level": 4,
        "name": "Samurai Longsword - Focus",
        "kind": "Weapon"
    },
    "4709": {
        "skillId": 3023,
        "level": 4,
        "name": "Samurai Longsword - Critical Damage",
        "kind": "Weapon"
    },
    "4710": {
        "skillId": 3037,
        "level": 4,
        "name": "Samurai Longsword - Haste",
        "kind": "Weapon"
    },
    "4711": {
        "skillId": 3023,
        "level": 1,
        "name": "Flamberge - Critical Damage",
        "kind": "Weapon"
    },
    "4712": {
        "skillId": 3010,
        "level": 1,
        "name": "Flamberge - Focus",
        "kind": "Weapon"
    },
    "4714": {
        "skillId": 3007,
        "level": 5,
        "name": "Keshanberk - Guidance",
        "kind": "Weapon"
    },
    "4715": {
        "skillId": 3010,
        "level": 5,
        "name": "Keshanberk - Focus",
        "kind": "Weapon"
    },
    "4716": {
        "skillId": 3018,
        "level": 5,
        "name": "Keshanberk - Back Blow",
        "kind": "Weapon"
    },
    "4717": {
        "skillId": 3010,
        "level": 6,
        "name": "Sword of Damascus - Focus",
        "kind": "Weapon"
    },
    "4718": {
        "skillId": 3023,
        "level": 3,
        "name": "Sword of Damascus - Critical Damage",
        "kind": "Weapon"
    },
    "4719": {
        "skillId": 3037,
        "level": 6,
        "name": "Sword of Damascus - Haste",
        "kind": "Weapon"
    },
    "4720": {
        "skillId": 3013,
        "level": 3,
        "name": "Tallum Blade - Health",
        "kind": "Weapon"
    },
    "4721": {
        "skillId": 3028,
        "level": 1,
        "name": "Tallum Blade - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4722": {
        "skillId": 3032,
        "level": 2,
        "name": "Tallum Blade - Rsk. Haste",
        "kind": "Weapon"
    },
    "4723": {
        "skillId": 3013,
        "level": 1,
        "name": "Great Sword - Health",
        "kind": "Weapon"
    },
    "4724": {
        "skillId": 3023,
        "level": 5,
        "name": "Great Sword - Critical Damage",
        "kind": "Weapon"
    },
    "4725": {
        "skillId": 3010,
        "level": 5,
        "name": "Great Sword - Focus",
        "kind": "Weapon"
    },
    "4726": {
        "skillId": 3013,
        "level": 1,
        "name": "Big Hammer - Health",
        "kind": "Weapon"
    },
    "4727": {
        "skillId": 3027,
        "level": 1,
        "name": "Big Hammer - Rsk.Focus",
        "kind": "Weapon"
    },
    "4728": {
        "skillId": 3037,
        "level": 1,
        "name": "Big Hammer - Haste",
        "kind": "Weapon"
    },
    "4729": {
        "skillId": 3012,
        "level": 1,
        "name": "Battle Axe - Anger",
        "kind": "Weapon"
    },
    "4730": {
        "skillId": 3027,
        "level": 1,
        "name": "Battle Axe - Rsk.Focus",
        "kind": "Weapon"
    },
    "4731": {
        "skillId": 3037,
        "level": 1,
        "name": "Battle Axe - Haste",
        "kind": "Weapon"
    },
    "4732": {
        "skillId": 3012,
        "level": 1,
        "name": "Silver Axe - Anger",
        "kind": "Weapon"
    },
    "4733": {
        "skillId": 3027,
        "level": 1,
        "name": "Silver Axe - Rsk.Focus",
        "kind": "Weapon"
    },
    "4734": {
        "skillId": 3037,
        "level": 1,
        "name": "Silver Axe - Haste",
        "kind": "Weapon"
    },
    "4735": {
        "skillId": 3012,
        "level": 1,
        "name": "Skull Graver - Anger",
        "kind": "Weapon"
    },
    "4736": {
        "skillId": 3013,
        "level": 1,
        "name": "Skull Graver - Health",
        "kind": "Weapon"
    },
    "4737": {
        "skillId": 3027,
        "level": 1,
        "name": "Skull Graver - Rsk.Focus",
        "kind": "Weapon"
    },
    "4738": {
        "skillId": 3012,
        "level": 2,
        "name": "Dwarven War Hammer - Anger",
        "kind": "Weapon"
    },
    "4739": {
        "skillId": 3013,
        "level": 1,
        "name": "Dwarven War Hammer - Health",
        "kind": "Weapon"
    },
    "4740": {
        "skillId": 3037,
        "level": 2,
        "name": "Dwarven War Hammer - Haste",
        "kind": "Weapon"
    },
    "4741": {
        "skillId": 3012,
        "level": 3,
        "name": "War Axe - Anger",
        "kind": "Weapon"
    },
    "4742": {
        "skillId": 3013,
        "level": 1,
        "name": "War Axe - Health",
        "kind": "Weapon"
    },
    "4743": {
        "skillId": 3037,
        "level": 3,
        "name": "War Axe - Haste",
        "kind": "Weapon"
    },
    "4744": {
        "skillId": 3012,
        "level": 4,
        "name": "Yaksa Mace - Anger",
        "kind": "Weapon"
    },
    "4745": {
        "skillId": 3013,
        "level": 1,
        "name": "Yaksa Mace - Health",
        "kind": "Weapon"
    },
    "4746": {
        "skillId": 3027,
        "level": 4,
        "name": "Yaksa Mace - Rsk. Focus",
        "kind": "Weapon"
    },
    "4747": {
        "skillId": 3012,
        "level": 5,
        "name": "Heavy War Axe - Anger",
        "kind": "Weapon"
    },
    "4748": {
        "skillId": 3013,
        "level": 1,
        "name": "Heavy War Axe - Health",
        "kind": "Weapon"
    },
    "4749": {
        "skillId": 3027,
        "level": 5,
        "name": "Heavy War Axe - Rsk. Focus",
        "kind": "Weapon"
    },
    "4750": {
        "skillId": 3012,
        "level": 6,
        "name": "Deadman's Glory - Anger",
        "kind": "Weapon"
    },
    "4751": {
        "skillId": 3013,
        "level": 1,
        "name": "Deadman's Glory - Health",
        "kind": "Weapon"
    },
    "4752": {
        "skillId": 3037,
        "level": 6,
        "name": "Deadman's Glory - Haste",
        "kind": "Weapon"
    },
    "4753": {
        "skillId": 3013,
        "level": 1,
        "name": "Art of Battle Axe - Health",
        "kind": "Weapon"
    },
    "4754": {
        "skillId": 3027,
        "level": 6,
        "name": "Art of Battle Axe - Rsk. Focus",
        "kind": "Weapon"
    },
    "4755": {
        "skillId": 3037,
        "level": 6,
        "name": "Art of Battle Axe - Haste",
        "kind": "Weapon"
    },
    "4756": {
        "skillId": 3013,
        "level": 1,
        "name": "Meteor Shower - Health",
        "kind": "Weapon"
    },
    "4757": {
        "skillId": 3010,
        "level": 1,
        "name": "Meteor Shower - Focus",
        "kind": "Weapon"
    },
    "4758": {
        "skillId": 3010,
        "level": 1,
        "name": "Meteor Shower - P.Focus",
        "kind": "Weapon"
    },
    "4761": {
        "skillId": 3033,
        "level": 1,
        "name": "Cursed Dagger - Rsk. Haste",
        "kind": "Weapon"
    },
    "4762": {
        "skillId": 3011,
        "level": 1,
        "name": "Dark Elven Dagger - Focus",
        "kind": "Weapon"
    },
    "4763": {
        "skillId": 3019,
        "level": 1,
        "name": "Dark Elven Dagger - Back Blow",
        "kind": "Weapon"
    },
    "4764": {
        "skillId": 3035,
        "level": 1,
        "name": "Dark Elven Dagger - Mortal Strike",
        "kind": "Weapon"
    },
    "4767": {
        "skillId": 3035,
        "level": 2,
        "name": "Stiletto - Mortal Strike",
        "kind": "Weapon"
    },
    "4768": {
        "skillId": 3009,
        "level": 3,
        "name": "Grace Dagger - Evasion",
        "kind": "Weapon"
    },
    "4769": {
        "skillId": 3011,
        "level": 3,
        "name": "Grace Dagger - Focus",
        "kind": "Weapon"
    },
    "4770": {
        "skillId": 3019,
        "level": 3,
        "name": "Grace Dagger - Back Blow",
        "kind": "Weapon"
    },
    "4771": {
        "skillId": 3009,
        "level": 3,
        "name": "Dark Screamer - Evasion",
        "kind": "Weapon"
    },
    "4772": {
        "skillId": 3011,
        "level": 3,
        "name": "Dark Screamer - Focus",
        "kind": "Weapon"
    },
    "4776": {
        "skillId": 3035,
        "level": 4,
        "name": "Crystal Dagger - Mortal Strike",
        "kind": "Weapon"
    },
    "4777": {
        "skillId": 3009,
        "level": 5,
        "name": "Kris - Evasion",
        "kind": "Weapon"
    },
    "4778": {
        "skillId": 3011,
        "level": 5,
        "name": "Kris - Focus",
        "kind": "Weapon"
    },
    "4779": {
        "skillId": 3019,
        "level": 5,
        "name": "Kris - Back Blow",
        "kind": "Weapon"
    },
    "4782": {
        "skillId": 3035,
        "level": 6,
        "name": "Demon Dagger - Mortal Strike",
        "kind": "Weapon"
    },
    "4783": {
        "skillId": 3009,
        "level": 6,
        "name": "Bloody Orchid - Evasion",
        "kind": "Weapon"
    },
    "4784": {
        "skillId": 3011,
        "level": 2,
        "name": "Bloody Orchid - Focus",
        "kind": "Weapon"
    },
    "4785": {
        "skillId": 3019,
        "level": 6,
        "name": "Bloody Orchid - Back Blow",
        "kind": "Weapon"
    },
    "4786": {
        "skillId": 3011,
        "level": 5,
        "name": "Hell Knife - Focus",
        "kind": "Weapon"
    },
    "4787": {
        "skillId": 3018,
        "level": 5,
        "name": "Hell Knife - Back Blow",
        "kind": "Weapon"
    },
    "4788": {
        "skillId": 3035,
        "level": 5,
        "name": "Hell Knife - Mortal Strike",
        "kind": "Weapon"
    },
    "4791": {
        "skillId": 3034,
        "level": 1,
        "name": "Chakram - Rsk. Haste",
        "kind": "Weapon"
    },
    "4792": {
        "skillId": 3030,
        "level": 3,
        "name": "Fisted Blade - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4793": {
        "skillId": 3034,
        "level": 3,
        "name": "Fisted Blade - Rsk. Haste",
        "kind": "Weapon"
    },
    "4794": {
        "skillId": 3037,
        "level": 3,
        "name": "Fisted Blade - Haste",
        "kind": "Weapon"
    },
    "4797": {
        "skillId": 3034,
        "level": 4,
        "name": "Great Pata - Rsk. Haste",
        "kind": "Weapon"
    },
    "4798": {
        "skillId": 3030,
        "level": 2,
        "name": "Knuckle Duster - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4799": {
        "skillId": 3034,
        "level": 2,
        "name": "Knuckle Duster - Rsk. Haste",
        "kind": "Weapon"
    },
    "4800": {
        "skillId": 3037,
        "level": 2,
        "name": "Knuckle Duster - Haste",
        "kind": "Weapon"
    },
    "4802": {
        "skillId": 3030,
        "level": 5,
        "name": "Arthro Nail - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4803": {
        "skillId": 3034,
        "level": 5,
        "name": "Arthro Nail - Rsk. Haste",
        "kind": "Weapon"
    },
    "4806": {
        "skillId": 3034,
        "level": 6,
        "name": "Bellion Cestus - Rsk. Haste",
        "kind": "Weapon"
    },
    "4808": {
        "skillId": 3030,
        "level": 6,
        "name": "Blood Tornado - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4809": {
        "skillId": 3037,
        "level": 6,
        "name": "Blood Tornado - Haste",
        "kind": "Weapon"
    },
    "4810": {
        "skillId": 3008,
        "level": 1,
        "name": "Crystallized Ice Bow - Guidance",
        "kind": "Weapon"
    },
    "4811": {
        "skillId": 3009,
        "level": 1,
        "name": "Crystallized Ice Bow - Evasion",
        "kind": "Weapon"
    },
    "4813": {
        "skillId": 3008,
        "level": 2,
        "name": "Elemental Bow - Guidance",
        "kind": "Weapon"
    },
    "4816": {
        "skillId": 3009,
        "level": 2,
        "name": "Elven Bow of Nobility - Evasion",
        "kind": "Weapon"
    },
    "4819": {
        "skillId": 3008,
        "level": 3,
        "name": "Akat Long Bow - Guidance",
        "kind": "Weapon"
    },
    "4820": {
        "skillId": 3009,
        "level": 3,
        "name": "Akat Long Bow - Evasion",
        "kind": "Weapon"
    },
    "4822": {
        "skillId": 3008,
        "level": 4,
        "name": "Eminence Bow - Guidance",
        "kind": "Weapon"
    },
    "4825": {
        "skillId": 3009,
        "level": 5,
        "name": "Dark Elven Long Bow - Evasion",
        "kind": "Weapon"
    },
    "4828": {
        "skillId": 3008,
        "level": 6,
        "name": "Bow of Peril - Guidance",
        "kind": "Weapon"
    },
    "4832": {
        "skillId": 3014,
        "level": 2,
        "name": "Carnage Bow - Mana Up",
        "kind": "Weapon"
    },
    "4834": {
        "skillId": 3600,
        "level": 1,
        "name": "Scythe - Anger",
        "kind": "Weapon"
    },
    "4837": {
        "skillId": 3600,
        "level": 1,
        "name": "Orcish Glaive - Anger",
        "kind": "Weapon"
    },
    "4839": {
        "skillId": 3599,
        "level": 1,
        "name": "Orcish Glaive - Towering Blow",
        "kind": "Weapon"
    },
    "4841": {
        "skillId": 3599,
        "level": 1,
        "name": "Body Slasher - Towering Blow",
        "kind": "Weapon"
    },
    "4842": {
        "skillId": 3599,
        "level": 1,
        "name": "Body Slasher - Wide Blow",
        "kind": "Weapon"
    },
    "4844": {
        "skillId": 3599,
        "level": 1,
        "name": "Bec de Corbin - Towering Blow",
        "kind": "Weapon"
    },
    "4846": {
        "skillId": 3600,
        "level": 3,
        "name": "Scorpion - Anger",
        "kind": "Weapon"
    },
    "4848": {
        "skillId": 3599,
        "level": 1,
        "name": "Scorpion - Towering Blow",
        "kind": "Weapon"
    },
    "4850": {
        "skillId": 3599,
        "level": 1,
        "name": "Widow Maker - Towering Blow",
        "kind": "Weapon"
    },
    "4851": {
        "skillId": 3599,
        "level": 1,
        "name": "Widow Maker - Wide Blow",
        "kind": "Weapon"
    },
    "4853": {
        "skillId": 3599,
        "level": 1,
        "name": "Orcish Poleaxe - Towering Blow",
        "kind": "Weapon"
    },
    "4854": {
        "skillId": 3599,
        "level": 1,
        "name": "Orcish Poleaxe - Wide Blow",
        "kind": "Weapon"
    },
    "4855": {
        "skillId": 3600,
        "level": 5,
        "name": "Great Axe - Anger",
        "kind": "Weapon"
    },
    "4858": {
        "skillId": 3600,
        "level": 6,
        "name": "Lance - Anger",
        "kind": "Weapon"
    },
    "4860": {
        "skillId": 3599,
        "level": 1,
        "name": "Lance - Towering Blow",
        "kind": "Weapon"
    },
    "4862": {
        "skillId": 3599,
        "level": 1,
        "name": "Halberd - Towering Blow",
        "kind": "Weapon"
    },
    "4863": {
        "skillId": 3599,
        "level": 1,
        "name": "Halberd - Wide Blow",
        "kind": "Weapon"
    },
    "4867": {
        "skillId": 3031,
        "level": 1,
        "name": "Crystal Staff - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4868": {
        "skillId": 3014,
        "level": 1,
        "name": "Crystal Staff - Mana Up",
        "kind": "Weapon"
    },
    "4879": {
        "skillId": 3031,
        "level": 3,
        "name": "Pa'agrian Hammer - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4885": {
        "skillId": 3014,
        "level": 1,
        "name": "Pa'agrian Axe - Mana Up",
        "kind": "Weapon"
    },
    "4891": {
        "skillId": 3031,
        "level": 4,
        "name": "Ghoul's Staff - Rsk. Evasion",
        "kind": "Weapon"
    },
    "4892": {
        "skillId": 3014,
        "level": 1,
        "name": "Ghoul's Staff - Mana Up",
        "kind": "Weapon"
    },
    "5596": {
        "skillId": 3014,
        "level": 2,
        "name": "Dasparion's Staff - Mana Up",
        "kind": "Weapon"
    },
    "5597": {
        "skillId": 3048,
        "level": 2,
        "name": "Dasparion's Staff - Conversion",
        "kind": "Weapon"
    },
    "5598": {
        "skillId": 3047,
        "level": 2,
        "name": "Dasparion's Staff - Acumen",
        "kind": "Weapon"
    },
    "5599": {
        "skillId": 3050,
        "level": 1,
        "name": "Meteor Shower - Focus",
        "kind": "Weapon"
    },
    "5601": {
        "skillId": 3056,
        "level": 1,
        "name": "Meteor Shower - Rsk. Haste",
        "kind": "Weapon"
    },
    "5602": {
        "skillId": 3013,
        "level": 3,
        "name": "Elysian - Health",
        "kind": "Weapon"
    },
    "5603": {
        "skillId": 3057,
        "level": 2,
        "name": "Elysian - Anger",
        "kind": "Weapon"
    },
    "5605": {
        "skillId": 3048,
        "level": 2,
        "name": "Branch of The Mother Tree - Conversion",
        "kind": "Weapon"
    },
    "5606": {
        "skillId": 3552,
        "level": 1,
        "name": "Branch of The Mother Tree - Magic Damage",
        "kind": "Weapon"
    },
    "5607": {
        "skillId": 3047,
        "level": 2,
        "name": "Branch of The Mother Tree - Acumen",
        "kind": "Weapon"
    },
    "5610": {
        "skillId": 3014,
        "level": 2,
        "name": "Carnage Bow - Mana Up",
        "kind": "Weapon"
    },
    "5614": {
        "skillId": 3051,
        "level": 1,
        "name": "Bloody Orchid - Focus",
        "kind": "Weapon"
    },
    "5615": {
        "skillId": 3063,
        "level": 1,
        "name": "Bloody Orchid - Back Blow",
        "kind": "Weapon"
    },
    "5617": {
        "skillId": 3064,
        "level": 1,
        "name": "Soul Separator - Guidance",
        "kind": "Weapon"
    },
    "5618": {
        "skillId": 3066,
        "level": 1,
        "name": "Soul Separator - Critical Damage",
        "kind": "Weapon"
    },
    "5619": {
        "skillId": 3056,
        "level": 1,
        "name": "Soul Separator - Rsk. Haste",
        "kind": "Weapon"
    },
    "5620": {
        "skillId": 3068,
        "level": 1,
        "name": "Blood Tornado - Haste",
        "kind": "Weapon"
    },
    "5621": {
        "skillId": 3050,
        "level": 1,
        "name": "Blood Tornado - Focus",
        "kind": "Weapon"
    },
    "5622": {
        "skillId": 3058,
        "level": 1,
        "name": "Blood Tornado - Anger",
        "kind": "Weapon"
    },
    "5623": {
        "skillId": 3069,
        "level": 1,
        "name": "Dragon Grinder - Rsk. Evasion",
        "kind": "Weapon"
    },
    "5624": {
        "skillId": 3065,
        "level": 1,
        "name": "Dragon Grinder - Guidance",
        "kind": "Weapon"
    },
    "5625": {
        "skillId": 3013,
        "level": 3,
        "name": "Dragon Grinder - Health",
        "kind": "Weapon"
    },
    "5626": {
        "skillId": 3601,
        "level": 7,
        "name": "Halberd - Haste",
        "kind": "Weapon"
    },
    "5632": {
        "skillId": 3602,
        "level": 8,
        "name": "Tallum Glaive - Guidance",
        "kind": "Weapon"
    },
    "5633": {
        "skillId": 3013,
        "level": 4,
        "name": "Tallum Glaive - Health",
        "kind": "Weapon"
    },
    "5636": {
        "skillId": 3068,
        "level": 1,
        "name": "Tallum Blade - Haste",
        "kind": "Weapon"
    },
    "5637": {
        "skillId": 3057,
        "level": 1,
        "name": "Tallum Blade - Anger",
        "kind": "Weapon"
    },
    "5638": {
        "skillId": 3073,
        "level": 1,
        "name": "Elemental Sword - Magic Power",
        "kind": "Weapon"
    },
    "5641": {
        "skillId": 3073,
        "level": 2,
        "name": "Sword of Miracles - Magic Power",
        "kind": "Weapon"
    },
    "5643": {
        "skillId": 3047,
        "level": 2,
        "name": "Sword of Miracles - Acumen",
        "kind": "Weapon"
    },
    "5644": {
        "skillId": 3013,
        "level": 3,
        "name": "Dragon Slayer - Health",
        "kind": "Weapon"
    },
    "5647": {
        "skillId": 3067,
        "level": 2,
        "name": "Dark Legion's Edge - Critical Damage",
        "kind": "Weapon"
    },
    "5648": {
        "skillId": 3013,
        "level": 3,
        "name": "Dark Legion's Edge - Health",
        "kind": "Weapon"
    },
    "5649": {
        "skillId": 3071,
        "level": 2,
        "name": "Dark Legion's Edge - Rsk. Focus",
        "kind": "Weapon"
    },
    "6307": {
        "skillId": 3573,
        "level": 1,
        "name": "Sword of Limit - Guidance",
        "kind": "Weapon"
    },
    "6309": {
        "skillId": 3013,
        "level": 1,
        "name": "Sword of Limit - Health",
        "kind": "Weapon"
    },
    "6310": {
        "skillId": 3072,
        "level": 1,
        "name": "Sword of Whispering Death - Empower",
        "kind": "Weapon"
    },
    "6311": {
        "skillId": 3077,
        "level": 1,
        "name": "Sword of Whispering Death - Magic Power",
        "kind": "Weapon"
    },
    "6313": {
        "skillId": 3047,
        "level": 1,
        "name": "Homunkulus's Sword - Acumen",
        "kind": "Weapon"
    },
    "6314": {
        "skillId": 3048,
        "level": 1,
        "name": "Homunkulus's Sword - Conversion",
        "kind": "Weapon"
    },
    "6347": {
        "skillId": 3010,
        "level": 4,
        "name": "Berserker Blade - Focus",
        "kind": "Weapon"
    },
    "6356": {
        "skillId": 3056,
        "level": 2,
        "name": "Dark Elven Dagger - Rsk. Haste",
        "kind": "Weapon"
    },
    "6357": {
        "skillId": 3056,
        "level": 2,
        "name": "Stiletto - Rsk. Haste",
        "kind": "Weapon"
    },
    "6358": {
        "skillId": 3043,
        "level": 1,
        "name": "Crystal Dagger - Critical Damage",
        "kind": "Weapon"
    },
    "6359": {
        "skillId": 3043,
        "level": 2,
        "name": "Demon Dagger - Critical Damage",
        "kind": "Weapon"
    },
    "6581": {
        "skillId": 3564,
        "level": 1,
        "name": "Forgotten Blade - Haste",
        "kind": "Weapon"
    },
    "6582": {
        "skillId": 3013,
        "level": 4,
        "name": "Forgotten Blade - Health",
        "kind": "Weapon"
    },
    "6583": {
        "skillId": 3566,
        "level": 1,
        "name": "Forgotten Blade - Focus",
        "kind": "Weapon"
    },
    "6585": {
        "skillId": 3013,
        "level": 1,
        "name": "Basalt Battlehammer - Health",
        "kind": "Weapon"
    },
    "6586": {
        "skillId": 3569,
        "level": 1,
        "name": "Basalt Battlehammer - HP Regeneration",
        "kind": "Weapon"
    },
    "6587": {
        "skillId": 3575,
        "level": 1,
        "name": "Imperial Staff - Empower",
        "kind": "Weapon"
    },
    "6588": {
        "skillId": 3576,
        "level": 1,
        "name": "Imperial Staff - MP Regeneration",
        "kind": "Weapon"
    },
    "6590": {
        "skillId": 3572,
        "level": 1,
        "name": "Angel Slayer - Crt. Damage",
        "kind": "Weapon"
    },
    "6592": {
        "skillId": 3564,
        "level": 1,
        "name": "Angel Slayer - Haste",
        "kind": "Weapon"
    },
    "6594": {
        "skillId": 3567,
        "level": 1,
        "name": "Shining Bow - Focus",
        "kind": "Weapon"
    },
    "6596": {
        "skillId": 3569,
        "level": 1,
        "name": "Dragon Hunter Axe - HP Regeneration",
        "kind": "Weapon"
    },
    "6597": {
        "skillId": 3013,
        "level": 1,
        "name": "Dragon Hunter Axe - Health",
        "kind": "Weapon"
    },
    "6599": {
        "skillId": 3013,
        "level": 4,
        "name": "Saint Spear - Health",
        "kind": "Weapon"
    },
    "6600": {
        "skillId": 3602,
        "level": 5,
        "name": "Saint Spear - Guidance",
        "kind": "Weapon"
    },
    "6601": {
        "skillId": 3564,
        "level": 1,
        "name": "Saint Spear - Haste",
        "kind": "Weapon"
    },
    "6602": {
        "skillId": 3565,
        "level": 1,
        "name": "Demon Splinter - Focus",
        "kind": "Weapon"
    },
    "6603": {
        "skillId": 3013,
        "level": 4,
        "name": "Demon Splinter - Health",
        "kind": "Weapon"
    },
    "6605": {
        "skillId": 3601,
        "level": 9,
        "name": "Heavens Divider - Haste",
        "kind": "Weapon"
    },
    "6606": {
        "skillId": 3013,
        "level": 4,
        "name": "Heavens Divider - Health",
        "kind": "Weapon"
    },
    "6607": {
        "skillId": 3566,
        "level": 1,
        "name": "Heavens Divider - Focus",
        "kind": "Weapon"
    },
    "6608": {
        "skillId": 3047,
        "level": 2,
        "name": "Arcana Mace - Acumen",
        "kind": "Weapon"
    },
    "6609": {
        "skillId": 3576,
        "level": 1,
        "name": "Arcana Mace - MP Regeneration",
        "kind": "Weapon"
    },
    "6610": {
        "skillId": 3014,
        "level": 2,
        "name": "Arcana Mace - Mana Up",
        "kind": "Weapon"
    },
    "6611": {
        "skillId": 3578,
        "level": 1,
        "name": "Infinity Blade",
        "kind": "Weapon"
    },
    "6612": {
        "skillId": 3582,
        "level": 1,
        "name": "Infinity Cleaver",
        "kind": "Weapon"
    },
    "6613": {
        "skillId": 3580,
        "level": 1,
        "name": "Infinity Axe",
        "kind": "Weapon"
    },
    "6614": {
        "skillId": 3597,
        "level": 1,
        "name": "Infinity Rod",
        "kind": "Weapon"
    },
    "6615": {
        "skillId": 3583,
        "level": 1,
        "name": "Infinity Crusher",
        "kind": "Weapon"
    },
    "6616": {
        "skillId": 3595,
        "level": 1,
        "name": "Infinity Scepter",
        "kind": "Weapon"
    },
    "6617": {
        "skillId": 3589,
        "level": 1,
        "name": "Infinity Stinger",
        "kind": "Weapon"
    },
    "6618": {
        "skillId": 3587,
        "level": 1,
        "name": "Infinity Fang",
        "kind": "Weapon"
    },
    "6619": {
        "skillId": 3593,
        "level": 1,
        "name": "Infinity Bow",
        "kind": "Weapon"
    },
    "6620": {
        "skillId": 3585,
        "level": 1,
        "name": "Infinity Wing",
        "kind": "Weapon"
    },
    "6621": {
        "skillId": 3591,
        "level": 1,
        "name": "Infinity Spear",
        "kind": "Weapon"
    },
    "6656": {
        "skillId": 3558,
        "level": 1,
        "name": "Earring of Antharas",
        "kind": "Armor"
    },
    "6657": {
        "skillId": 3557,
        "level": 1,
        "name": "Necklace of Valakas",
        "kind": "Armor"
    },
    "6658": {
        "skillId": 3561,
        "level": 1,
        "name": "Ring of Baium",
        "kind": "Armor"
    },
    "6659": {
        "skillId": 3559,
        "level": 1,
        "name": "Zaken's Earring",
        "kind": "Armor"
    },
    "6660": {
        "skillId": 3562,
        "level": 1,
        "name": "Ring of Queen Ant",
        "kind": "Armor"
    },
    "6661": {
        "skillId": 3560,
        "level": 1,
        "name": "Earring of Orfen",
        "kind": "Armor"
    },
    "6662": {
        "skillId": 3563,
        "level": 1,
        "name": "Ring of Core",
        "kind": "Armor"
    },
    "7577": {
        "skillId": 3567,
        "level": 1,
        "name": "Draconic Bow - Focus",
        "kind": "Weapon"
    },
    "7701": {
        "skillId": 3014,
        "level": 1,
        "name": "Stick of Faith - Mana Up",
        "kind": "Weapon"
    },
    "7710": {
        "skillId": 3047,
        "level": 1,
        "name": "Club of Nature - Acumen",
        "kind": "Weapon"
    },
    "7713": {
        "skillId": 3014,
        "level": 1,
        "name": "Mace of The Underworld - Mana Up",
        "kind": "Weapon"
    },
    "7715": {
        "skillId": 3048,
        "level": 1,
        "name": "Mace of The Underworld - Conversion",
        "kind": "Weapon"
    },
    "7716": {
        "skillId": 3047,
        "level": 1,
        "name": "Inferno Staff - Acumen",
        "kind": "Weapon"
    },
    "7722": {
        "skillId": 3047,
        "level": 1,
        "name": "Sword of Valhalla - Acumen",
        "kind": "Weapon"
    },
    "7810": {
        "skillId": 3014,
        "level": 1,
        "name": "Soulfire Dirk - Mana Up",
        "kind": "Weapon"
    }
};
const SKILLS = {
    "3007": {
        "name": "Special Ability: Guidance",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAccuracyCombatAdd": 6.88
            },
            "2": {
                "pAccuracyCombatAdd": 6.07
            },
            "3": {
                "pAccuracyCombatAdd": 5.72
            },
            "4": {
                "pAccuracyCombatAdd": 5.37
            },
            "5": {
                "pAccuracyCombatAdd": 5.02
            },
            "6": {
                "pAccuracyCombatAdd": 4.68
            }
        },
        "conditional": []
    },
    "3008": {
        "name": "Special Ability: Guidance",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAccuracyCombatAdd": 5.42
            },
            "2": {
                "pAccuracyCombatAdd": 5.12
            },
            "3": {
                "pAccuracyCombatAdd": 4.82
            },
            "4": {
                "pAccuracyCombatAdd": 4.53
            },
            "5": {
                "pAccuracyCombatAdd": 4.24
            },
            "6": {
                "pAccuracyCombatAdd": 3.95
            }
        },
        "conditional": []
    },
    "3009": {
        "name": "Special Ability: Evasion",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pEvasionRateAdd": 2.95
            },
            "2": {
                "pEvasionRateAdd": 2.82
            },
            "3": {
                "pEvasionRateAdd": 2.68
            },
            "4": {
                "pEvasionRateAdd": 2.55
            },
            "5": {
                "pEvasionRateAdd": 2.41
            },
            "6": {
                "pEvasionRateAdd": 2.28
            }
        },
        "conditional": []
    },
    "3010": {
        "name": "Special Ability: Focus",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritRateAdd": 86.7
            },
            "2": {
                "pCritRateAdd": 82.2
            },
            "3": {
                "pCritRateAdd": 77.8
            },
            "4": {
                "pCritRateAdd": 73.3
            },
            "5": {
                "pCritRateAdd": 68.9
            },
            "6": {
                "pCritRateAdd": 64.5
            }
        },
        "conditional": []
    },
    "3011": {
        "name": "Special Ability: Focus",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritRateAdd": 90.5
            },
            "2": {
                "pCritRateAdd": 85.9
            },
            "3": {
                "pCritRateAdd": 81.2
            },
            "4": {
                "pCritRateAdd": 76.6
            },
            "5": {
                "pCritRateAdd": 71.9
            },
            "6": {
                "pCritRateAdd": 67.3
            }
        },
        "conditional": []
    },
    "3012": {
        "name": "Special Ability: Anger",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAtkAdd": 20.44,
                "maxHpMul": 0.85
            },
            "2": {
                "pAtkAdd": 22.64,
                "maxHpMul": 0.85
            },
            "3": {
                "pAtkAdd": 24.77,
                "maxHpMul": 0.85
            },
            "4": {
                "pAtkAdd": 26.78,
                "maxHpMul": 0.85
            },
            "5": {
                "pAtkAdd": 28.59,
                "maxHpMul": 0.85
            },
            "6": {
                "pAtkAdd": 30.12,
                "maxHpMul": 0.85
            }
        },
        "conditional": []
    },
    "3013": {
        "name": "Special Ability: Health",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "maxHpMul": 1.25,
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "3": {
                "maxHpMul": 1.25,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "4": {
                "maxHpMul": 1.25,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "5": {
                "maxHpMul": 1.25,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3014": {
        "name": "Special Ability: Mana Up",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "maxMpMul": 1.3,
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "maxMpMul": 1.3,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "maxMpMul": 1.3,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3018": {
        "name": "Special Ability: Back Blow",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "basemul:rCrit"
        ]
    },
    "3019": {
        "name": "Special Ability: Back Blow",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "basemul:rCrit"
        ]
    },
    "3023": {
        "name": "Special Ability: Critical Damage",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritDamageAdd": 174.78
            },
            "2": {
                "pCritDamageAdd": 194.1
            },
            "3": {
                "pCritDamageAdd": 213.12
            },
            "4": {
                "pCritDamageAdd": 231.29
            },
            "5": {
                "pCritDamageAdd": 247.98
            },
            "6": {
                "pCritDamageAdd": 262.57
            }
        },
        "conditional": []
    },
    "3026": {
        "name": "Special Ability: Critical Anger",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": []
    },
    "3027": {
        "name": "Special Ability: Rsk. Focus",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "3": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "4": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "5": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "6": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            }
        },
        "conditional": [
            "add:rCrit"
        ]
    },
    "3028": {
        "name": "Special Ability: Rsk. Evasion",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "add:rEvas"
        ]
    },
    "3030": {
        "name": "Special Ability: Rsk. Evasion",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "add:rEvas"
        ]
    },
    "3031": {
        "name": "Special Ability: Rsk. Evasion",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "add:rEvas"
        ]
    },
    "3032": {
        "name": "Special Ability: Rsk. Haste",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "mul:pAtkSpd"
        ]
    },
    "3033": {
        "name": "Special Ability: Rsk. Haste",
        "source": "3000-3099.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {}
        },
        "conditional": [
            "mul:pAtkSpd"
        ]
    },
    "3034": {
        "name": "Special Ability: Rsk. Haste",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "3": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "4": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "5": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "6": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            }
        },
        "conditional": [
            "mul:pAtkSpd"
        ]
    },
    "3035": {
        "name": "Special Ability: Mighty Mortal",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "blowRateMul": 1.5
            },
            "2": {
                "blowRateMul": 1.48
            },
            "3": {
                "blowRateMul": 1.46
            },
            "4": {
                "blowRateMul": 1.44
            },
            "5": {
                "blowRateMul": 1.42
            },
            "6": {
                "blowRateMul": 1.4
            }
        },
        "conditional": []
    },
    "3037": {
        "name": "Special Ability: Haste",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAtkSpdMul": 1.08
            },
            "2": {
                "pAtkSpdMul": 1.07
            },
            "3": {
                "pAtkSpdMul": 1.07
            },
            "4": {
                "pAtkSpdMul": 1.07
            },
            "5": {
                "pAtkSpdMul": 1.06
            },
            "6": {
                "pAtkSpdMul": 1.06
            }
        },
        "conditional": []
    },
    "3043": {
        "name": "Special Ability: Critical Damage",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritDamageAdd": 106.45
            },
            "2": {
                "pCritDamageAdd": 118.22
            },
            "3": {
                "pCritDamageAdd": 129.81
            },
            "4": {
                "pCritDamageAdd": 140.87
            },
            "5": {
                "pCritDamageAdd": 151.04
            },
            "6": {
                "pCritDamageAdd": 159.93
            }
        },
        "conditional": []
    },
    "3047": {
        "name": "Special Ability: Acumen",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "castSpdMul": 1.15,
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "castSpdMul": 1.15,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "castSpdMul": 1.15,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3048": {
        "name": "Special Ability: Conversion",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "maxMpMul": 1.6,
                "maxHpMul": 0.6,
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "maxMpMul": 1.6,
                "maxHpMul": 0.6,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "maxMpMul": 1.6,
                "maxHpMul": 0.6,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3050": {
        "name": "Special Ability: Focus",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritRateAdd": 61.6,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pCritRateAdd": 61.6,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3051": {
        "name": "Special Ability: Focus",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritRateAdd": 67.3,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pCritRateAdd": 67.3,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3056": {
        "name": "Special Ability: Rsk. Haste",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": [
            "mul:pAtkSpd"
        ]
    },
    "3057": {
        "name": "Special Ability: Anger",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAtkAdd": 31.3,
                "maxHpMul": 0.85,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pAtkAdd": 32.05,
                "maxHpMul": 0.85,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "pAtkAdd": 32.05,
                "maxHpMul": 0.85,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3058": {
        "name": "Special Ability: Anger",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAtkAdd": 38.09,
                "maxHpMul": 0.85,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pAtkAdd": 39,
                "maxHpMul": 0.85,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3063": {
        "name": "Special Ability: Back Blow",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": [
            "basemul:rCrit"
        ]
    },
    "3064": {
        "name": "Special Ability: Guidance",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAccuracyCombatAdd": 3.95,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3065": {
        "name": "Special Ability: Guidance",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAccuracyCombatAdd": 5.41,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3066": {
        "name": "Special Ability: Critical Damage",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritDamageAdd": 180.94,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pCritDamageAdd": 200.79,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "pCritDamageAdd": 200.79,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3067": {
        "name": "Special Ability: Critical Damage",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pCritDamageAdd": 297.68,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "pCritDamageAdd": 326.28,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3068": {
        "name": "Special Ability: Haste",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pAtkSpdMul": 1.06,
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "pAtkSpdMul": 1.06,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "3": {
                "pAtkSpdMul": 1.06,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3069": {
        "name": "Special Ability: Risky Evasion",
        "source": "3000-3099.xml",
        "levels": {
            "1": {}
        },
        "conditional": [
            "add:rEvas"
        ]
    },
    "3071": {
        "name": "Special Ability: Rsk. Focus",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "pvpPhysDmg": 1,
                "pvpPhysSkillsDmg": 1,
                "pvpMagicalDmg": 1
            },
            "2": {
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": [
            "add:rCrit"
        ]
    },
    "3072": {
        "name": "Special Ability: Empower",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "mAtkAdd": 30.76,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "mAtkAdd": 31.38,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3073": {
        "name": "Special Ability: Magic Power",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "mAtkAdd": 153.28,
                "magicalMpConsumeRateMul": 1.15,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            },
            "2": {
                "mAtkAdd": 167.02,
                "magicalMpConsumeRateMul": 1.15,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3077": {
        "name": "Special Ability: Magic Power",
        "source": "3000-3099.xml",
        "levels": {
            "1": {
                "mAtkAdd": 75.86,
                "magicalMpConsumeRateMul": 1.15
            },
            "2": {
                "mAtkAdd": 87.22,
                "magicalMpConsumeRateMul": 1.15
            },
            "3": {
                "mAtkAdd": 99.39,
                "magicalMpConsumeRateMul": 1.15
            },
            "4": {
                "mAtkAdd": 112.26,
                "magicalMpConsumeRateMul": 1.15
            },
            "5": {
                "mAtkAdd": 125.66,
                "magicalMpConsumeRateMul": 1.15
            },
            "6": {
                "mAtkAdd": 139.41,
                "magicalMpConsumeRateMul": 1.15
            }
        },
        "conditional": []
    },
    "3552": {
        "name": "Special Ability: PvP Damage",
        "source": "3500-3599.xml",
        "levels": {
            "1": {},
            "2": {}
        },
        "conditional": []
    },
    "3557": {
        "name": "Necklace of Valakas",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpAdd": 445,
                "pAtkMul": 1.04,
                "mAtkMul": 1.08,
                "mCritRate": 2,
                "fireVuln": 0.85,
                "sleepVuln": 0.2,
                "mReuseMul": 0.9,
                "pReuseMul": 0.9,
                "reflectDam": 5
            }
        },
        "conditional": []
    },
    "3558": {
        "name": "Earring of Antharas",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "bleedVuln": 0.2,
                "gainHpMul": 1.1,
                "absorbDam": 4,
                "stunVuln": 0.3,
                "derangementVuln": 0.3,
                "magicalMpConsumeRateMul": 0.95,
                "physicalMpConsumeRateMul": 0.95,
                "earthVuln": 0.85
            }
        },
        "conditional": []
    },
    "3559": {
        "name": "Earring of Zaken",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "bleedVuln": 0.4,
                "gainHpMul": 1.1,
                "absorbDam": 4,
                "stunVuln": 0.4,
                "derangementVuln": 0.4
            }
        },
        "conditional": []
    },
    "3560": {
        "name": "Earring of Orfen",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "bleedVuln": 0.6,
                "gainHpMul": 1.06
            }
        },
        "conditional": []
    },
    "3561": {
        "name": "Ring of Baium",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "poisonVuln": 0.2,
                "pAccuracyCombatAdd": 2,
                "pCritDamageMul": 1.15,
                "rootVuln": 0.4,
                "pAtkSpdMul": 1.04,
                "castSpdMul": 1.04
            }
        },
        "conditional": []
    },
    "3562": {
        "name": "Ring of Ant Queen",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "poisonVuln": 0.4,
                "pAccuracyCombatAdd": 2,
                "pCritDamageMul": 1.15,
                "rootVuln": 0.6
            }
        },
        "conditional": []
    },
    "3563": {
        "name": "Ring of Core",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "poisonVuln": 0.6,
                "pAccuracyCombatAdd": 1
            }
        },
        "conditional": []
    },
    "3564": {
        "name": "Special Ability: Haste",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3565": {
        "name": "Special Ability: Focus",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3566": {
        "name": "Special Ability: Focus",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3567": {
        "name": "Special Ability: Focus",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "pCritRateAdd": 88,
                "pvpPhysDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "pvpMagicalDmg": 1.05
            }
        },
        "conditional": []
    },
    "3569": {
        "name": "Special Ability: HP Regeneration",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3572": {
        "name": "Special Ability: Crt. Damage",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3573": {
        "name": "Special Ability: Guidance",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3575": {
        "name": "Special Ability: Empower Option",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3576": {
        "name": "Special Ability: MP Regeneration",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3578": {
        "name": "Special Ability: Infinity Blade",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "sDefMul": 1.33,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectDam": 9
            }
        },
        "conditional": []
    },
    "3580": {
        "name": "Special Ability: Infinity Axe",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "maxMpMul": 1.3,
                "rShldMul": 1.39,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectDam": 9
            }
        },
        "conditional": []
    },
    "3582": {
        "name": "Special Ability: Infinity Cleaver",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "pCritDamageAdd": 504,
                "maxHpMul": 1.25,
                "maxCpMul": 1.5,
                "pCritRateAdd": 78.7,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectSkillPhysic": 10,
                "reflectSkillMagic": 10
            }
        },
        "conditional": []
    },
    "3583": {
        "name": "Special Ability: Infinity Crusher",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "maxCpMul": 1.5,
                "pAtkSpdMul": 1.07,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectSkillPhysic": 10,
                "reflectSkillMagic": 10
            }
        },
        "conditional": []
    },
    "3585": {
        "name": "Special Ability: Infinity Wing",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "pCritRateAdd": 78.7,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectSkillPhysic": 10,
                "reflectSkillMagic": 10
            }
        },
        "conditional": []
    },
    "3587": {
        "name": "Special Ability: Infinity Fang",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "pEvasionRateAdd": 3.15,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectSkillPhysic": 10,
                "reflectSkillMagic": 10
            }
        },
        "conditional": []
    },
    "3589": {
        "name": "Special Ability: Infinity Stinger",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "pAtkSpdMul": 1.03,
                "regMp": 0.51,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "absorbDamMul": 1.02
            }
        },
        "conditional": [
            "add:regMp"
        ]
    },
    "3591": {
        "name": "Special Ability: Infinity Spear",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxHpMul": 1.25,
                "maxCpMul": 1.5,
                "pAtkSpdMul": 1.07,
                "pAccuracyCombatAdd": 4.89,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "reflectSkillPhysic": 10,
                "reflectSkillMagic": 10
            }
        },
        "conditional": []
    },
    "3593": {
        "name": "Special Ability: Infinity Bow",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05
            }
        },
        "conditional": []
    },
    "3595": {
        "name": "Special Ability: Infinity Scepter",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "mAtkAdd": 29.67,
                "mCritRate": 1.54,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05,
                "magicalMpConsumeRateMul": 0.96,
                "cancel": -106
            }
        },
        "conditional": []
    },
    "3597": {
        "name": "Special Ability: Infinity Rod",
        "source": "3500-3599.xml",
        "levels": {
            "1": {
                "maxMpMul": 1.3,
                "maxCpMul": 1.5,
                "castSpdMul": 1.15,
                "regMp": 0.51,
                "pvpPhysDmg": 1.05,
                "pvpMagicalDmg": 1.05,
                "pvpPhysSkillsDmg": 1.05
            }
        },
        "conditional": []
    },
    "3599": {
        "name": "Polearm Multi-attack",
        "source": "3500-3599.xml",
        "levels": {
            "1": {}
        },
        "conditional": []
    },
    "3600": {
        "name": "Special Ability: Anger",
        "source": "3600-3699.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {},
            "7": {},
            "8": {},
            "9": {}
        },
        "conditional": []
    },
    "3601": {
        "name": "Special Ability: Haste",
        "source": "3600-3699.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {},
            "7": {},
            "8": {},
            "9": {}
        },
        "conditional": []
    },
    "3602": {
        "name": "Special Ability: Guidance",
        "source": "3600-3699.xml",
        "levels": {
            "1": {},
            "2": {},
            "3": {},
            "4": {},
            "5": {},
            "6": {},
            "7": {},
            "8": {},
            "9": {}
        },
        "conditional": []
    }
};

function resolveItem(itemSelfId) {
    return ITEM_SKILLS[String(Number(itemSelfId))] || null;
}

function statsFor(skillId, level = 1) {
    const skill = SKILLS[String(Number(skillId))];
    if (!skill) return null;
    const wantedLevel = String(Number(level) || 1);
    const stats = skill.levels[wantedLevel] || skill.levels[String(Object.keys(skill.levels).length)] || {};
    return {
        skillId: Number(skillId),
        level: Number(wantedLevel),
        name: skill.name,
        source: skill.source,
        conditional: skill.conditional || [],
        stats: { ...stats }
    };
}

function effectForItem(item) {
    const itemSelfId = Number(item?.fetchSelfId?.());
    const itemId = Number(item?.fetchId?.()) || itemSelfId;
    const itemSkill = resolveItem(itemSelfId);
    if (!itemSkill) return null;
    const skill = statsFor(itemSkill.skillId, itemSkill.level);
    if (!skill || Object.keys(skill.stats).length === 0) return null;

    return {
        key: `equipment_item_skill:${itemId}:${skill.skillId}:${skill.level}`,
        id: skill.skillId,
        level: skill.level,
        type: 'item_passive',
        name: skill.name,
        category: CATEGORY,
        dispellable: false,
        stats: skill.stats
    };
}

function sync(actor, items = []) {
    if (!actor) return [];
    EffectStore.removeByCategory(actor, CATEGORY);
    const applied = [];
    items
        .filter((item) => item?.fetchEquipped?.() === true)
        .forEach((item) => {
            const effect = effectForItem(item);
            if (effect) {
                applied.push(EffectStore.apply(actor, effect));
            }
        });
    return applied.filter(Boolean);
}

module.exports = {
    CATEGORY,
    ITEM_SKILLS,
    SKILLS,
    resolveItem,
    statsFor,
    effectForItem,
    sync
};
