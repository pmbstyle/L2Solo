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
