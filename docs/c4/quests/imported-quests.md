# Imported C4 quests

Selected content from [Sedentarius's PR #121](https://github.com/pmbstyle/L2Solo/pull/121), revision `a86513cf98decfcc433c66840001429a5887c38b`. The original scripts cite MOBIUS_C4 revision `6674a607`; this import does not claim an independent certification of that reference.

## Scope

Only the 46 missing quests are added: 30 declarative definitions and 16 individual entry modules. Existing quest scripts, their registry priority, first-profession quests, direct Gatekeeper transfer and bot progression are retained. Q038/Q039 remain disabled.

Their 28 NPC templates, 31 spawn entries and nine missing item templates are included. Existing quest-givers retain their positions. Dimension Keepers for Heretics, Apostate and Forbidden Path use the current C4 dungeon entrances rather than relocated dungeon coordinates. Q635 supplies passage to and from the rift outpost, not a full rift encounter instance.

## Persistence and beginner rewards

Migration 47 adds beginner eligibility and a receipt, preserving raid migrations 45 and 46. The account's first new character is eligible; existing characters receive an unknown flag.

The imported Q257/Q260/Q265/Q273/Q293 bounties use `General.newbieRewardPolicy`: `strict` (default) requires known eligibility; `grant` additionally permits existing characters whose eligibility is unknown; `always` permits every character. All modes retain the once-per-character receipt. Existing quest rewards are unchanged.

The new quest-step transaction persists state, items, XP/SP and beginner receipts together. Sin Eater PK reduction is included in the same transaction as collar consumption. Existing pet quest transactions and class transfer code are retained.

## Validation

Regression tests use temporary SQLite databases for dialogue, drops, hand-ins and restart behavior. `tests/test_c4_import_integration.js` also covers the production Actor layout, receipt reload, rollback on a failed PK write, renewal after partial PK reduction, quest adena rates and placement at existing dungeon entrances. These tests do not replace a C4 client walkthrough. The upstream certificate and evidence hashes are not imported. KnowledgeBase artifacts are regenerated from the current branch, which also incorporates its previously added SA items.

## Added quests

| ID | Quest |
|---|---|
| 257 | The Guard is Busy |
| 258 | Bring Wolf Pelts |
| 259 | Rancher's Plea |
| 260 | Orc Hunting |
| 261 | Collector's Dream |
| 262 | Trade with the Ivory Tower |
| 263 | Orc Subjugation |
| 264 | Keen Claws |
| 265 | Bonds of Slavery |
| 266 | Pleas of Pixies |
| 267 | Wrath of Verdure |
| 271 | Proof of Valor |
| 272 | Wrath of Ancestors |
| 273 | Invaders of the Holy Land |
| 274 | Skirmish with the Werewolves |
| 275 | Dark Winged Spies |
| 276 | Totem of the Hestui |
| 277 | Gatekeeper's Offering |
| 291 | Revenge of the Redbonnet |
| 292 | Brigands Sweep |
| 293 | The Hidden Veins |
| 294 | Covert Business |
| 295 | Dreaming of the Skies |
| 296 | Tarantula's Spider Silk |
| 297 | Gatekeeper's Favor |
| 303 | Collect Arrowheads |
| 306 | Crystals of Fire and Ice |
| 313 | Collect Spores |
| 316 | Destroy Plague Carriers |
| 317 | Catch the Wind |
| 319 | Scent of Death |
| 320 | Bones Tell the Future |
| 324 | Sweetest Venom |
| 325 | Grim Collector |
| 340 | Subjugation of Lizardmen |
| 341 | Hunting for Wild Beasts |
| 347 | Go Get the Calculator |
| 362 | Bard's Mandolin |
| 363 | Sorrowful Sound of Flute |
| 364 | Jovial Accordion |
| 378 | Magnificent Feast |
| 379 | Fantasy Wine |
| 385 | Yoke of the Past |
| 422 | Repent Your Sins |
| 634 | In Search of Fragments of the Dimension |
| 635 | In the Dimensional Rift |

## Level 20-30 imports (298/326/327/328/330/333/369/370/380)

Nine further quests were authored against the pinned Lisvus datapack (revision `fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975` script tree): 298 Lizardmen's Conspiracy, 326 Vanquish Remnants, 327 Reclaim the Land, 328 Sense For Business, 330 Adept of Taste, 333 The Black Lion Hunt, 369 Collector of Jewels, 370 A Wiseman Sows Seeds, 380 Bring Out the Flavour of Ingredients. 298/326/328/369/370/380 are declarative definitions, 327/330/333 are entry modules. The generator `scripts/generate-c4-middle-quests.js` produces the thirteen quest item templates and the Maille Lizardmen 922-926 templates, spawns and drop rewards, all read from the vendor tree.

Supporting engine work: declarative threshold bonuses may now pay in items (`give`) and can stay quiet once the item is held (`onlyIfMissing`), a bonus without an `adena` key no longer poisons the payment total, and a quest step that requests zero of an item type skips it instead of failing the shortage check.

Runtime coverage lives in `tests/test_c4_middle_quests.js`; the declarative driver in `tests/test_c4_declarative_quests.js` starts these definitions and checks their start NPCs, while the talk-chain completion driver walks only the definitions it can represent.

Known deviations from the reference scripts:

- 369: the reference rolls party-member drops for the shard mobs; single-player drops follow the same per-mob chances without the party table.
- 326: the black lion mark bonus counts the badges sold in one transaction rather than a lifetime total, so it pays when a single sale reaches one hundred.
- 370: the reference re-opens the loop by re-issuing chapters after delivery; here one acceptance pays one delivery of four chapters, the 3600 Adena is static and unscaled, and stage one keeps dropping while the quest is open.
- 380: the recipe is drawn once on the quest's final talk (55%), and the ritron jelly is granted once per completion; the reference's per-visit RNG is folded into that single roll.
- Dialogue pages paraphrase the reference HTML; the vendor `.htm` pages themselves are not imported.

## Level 20-30 completion (334 The Wishing Potion)

With the official quest-level table applied to every remaining vendor script (the
C4 quest database), the level 20-30 window closes at 334 The Wishing Potion
(level 30): every other unregistered Lisvus quest starts at level 31 or later -
216-235 and 241-247 are second class-transfer lines (35+), 255 is the tutorial
script, and 426/503 are the level-restricted fishing and clan-hall utilities.

334 is an entry module (`Q334_TheWishingPotion`): the level-30 gate, the Secret
Book off the Secret Keeper Tree, the two recipe lists, the eight script-dropped
ingredients (one each, per-mob chances 15-50), the brew that keeps
Matild's Orb and stays open, the four wishes with their spawn outcomes (three
Succubi, Rupina's pendant, three Grima, the Certificate/Crown/Sanches split and
the spellbook tables or Wisdom Chest), the Torai scroll sale, the Grima purse
and the four-kill Sanches chain. The twenty-one missing C3/C4 spellbook rewards
are extracted by the same generator into
`data/Items/Others/c4_quest_334_items.json`; every quest item, NPC, mob and the
Matild/Torai/Secret-Keeper spawns already shipped in the datapack.

Runtime coverage is a dedicated certification,
`tests/test_c4_wishing_potion.js`, on the full quest harness with quest spawns
enabled (as with 340's chest).

Known deviations from the reference script:

- The reference runs the wish ceremony on 3s/4s/4s quest timers with NpcSay
  broadcasts and a busy Matild (7738-20); the engine has neither quest timers
  nor NPC chat broadcast, so the ceremony collapses into the wish page and the
  outcome (spawns or reward) lands with the bypass.
- Grima, the Succubi, Rupina, the Wisdom Chest and the whole Sanches chain are
  quest-spawned at the character, owner-scoped and time-limited exactly as the
  reference `addSpawn` durations (200s/120s/600s). The reference data spawns
  none of them statically, and neither do we.
- The under-30 refusal shows the 7738-21 text without the reference's
  `exitQuest(1)` reset, which is unreachable below level 30 anyway.
- Torai (7557) doubles as 417's start NPC; while 334 is running the
  started-quest-first dispatch routes its talk to 334, matching the
  reference's scroll-only branch.
- Like the reference, the quest never marks itself completed: the cond-5 orb
  holder re-accepts at 7738-03 and brews again.
- Torai's 500000, the 10000/900000/100000000/1412965 purses and the
  1412965/10000 wish payouts go through the server's questAdena profile.
