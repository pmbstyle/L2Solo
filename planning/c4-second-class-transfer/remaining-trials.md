# Remaining C4 second-profession trials

The six shared trials below complete the quest content required by the existing
31 second-profession routes. Character class changes still require level 40,
three earned marks and the appropriate village master.

## Primary sources

- [Lisvus C4 datapack](https://gitlab.com/TheDnR/l2j-lisvus/-/tree/fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975/datapack/data/scripts/quests), pinned to `fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975`: Q213 and Q214 Java scripts; Q224, Q228, Q229 and Q230 Python scripts.
- [Historical C4 datapack](https://gitlab.com/l2jc/l2j-server-datapack/-/tree/37a3ec950528622df8a894de2d82bfc697f45383/L2J_DataPack/data/jscript/quests), pinned to `37a3ec950528622df8a894de2d82bfc697f45383`: Q213 and Q214 each award eight Dimensional Diamonds once. This resolves duplicate reward calls in the Lisvus Java versions.
- [Lisvus spawnlist](https://gitlab.com/TheDnR/l2j-lisvus/-/blob/fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975/datapack/sql/spawnlist.sql): the six summoning-duel locations.
- [Lisvus skill trees](https://gitlab.com/TheDnR/l2j-lisvus/-/blob/fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975/datapack/sql/skill_trees.sql): transfer skill ranks at level 40.

## Quest requirements

| Quest | Start / level / classes | NPC route and objectives | Reward at x1 |
| --- | --- | --- | --- |
| Q213 Trial of the Seeker | Dufner 7106; 35; Rogue, Elven Scout, Assassin | Terry 7064 → Viktor 7684 → Terry → Viktor → Marina 7715 → Brunon 7526 → Marina → Terry → Dufner. First bezoar, four dark bezoars, ten Medusa scales, four host runes. Terry's final investigation requires level 36. | Mark 2673; 72,126 XP; 11,000 SP; 8 diamonds |
| Q214 Trial of the Scholar | Mirien 7461; 35; Human/Elven/Dark Wizard | Sylvain 7070; Maria 7608 / Lukas 7071 / Creta 7609 and five scroll scraps; Jurek 7115 and 5 skins, 5 necklaces, 2 scalps; Cronos 7610 / Dieter 7111 / Creta / Raut 7230 / Torai 7316 / Triff 7611. Collect four chapters: Valkon 7103 / Maria; Trisalim; Poitan 7458 / Casian 7612 and 10 Ghoul skins, 12 Medusa blood, 5 ichor, 5 nails. Return to Cronos and Mirien. Cronos's phase requires level 36. | Mark 2674; 80,265 XP; 30,000 SP; 8 diamonds |
| Q224 Test of Sagittarius | Bernard 7702; 39; Rogue, Elven Scout, Assassin | Hamil 7626 → Tanford 7653 → Hamil → Manakia 7514 → Hamil → Gauen 7717 → Hamil. Ten ant runes, ten Breka runes, four bow parts; accumulate Leto blood and defeat Kadesh 5090 while wielding Crescent Moon Bow 3028. | Mark 3293; 54,726 XP; 20,250 SP |
| Q228 Test of the Magus | Rukal 7629; 39; Human/Elven/Dark Wizard | Parina 7391 → Casian 7612 → three singing flowers → Rukal. Water 7413: 20 drops; Fire 7411: 5 crystals; Wind 7412: 20 feathers, 10 wings, 10 manes; Earth 7409: 10 shells, 10 powder, 10 scraps. The four tones can be collected in any order. Once an elemental branch has been accepted, the source allows all elemental material drops. | Mark 2840; 139,039 XP; 40,000 SP |
| Q229 Test of Witchcraft | Orim 7630; 39; Human Wizard, Human Knight, Palus Knight | Alexandria 7098; gems through Iker 7110 (20 fangs, charms, hearts), Kaira 7476, Lara 7063, Nestle 7314 / Leopold 7435. First Dre Vanul 5101 encounter; independently obtain Iker's soultrap and Klaus Vasper 7417 / Vadin 7188's Sword of Binding 3029 (20 Tamlin amulets). Evert 7633's final Dre Vanul must be defeated while wielding that sword. Return crystal, key and tools to Orim. Roderik 7631 and Endrigo 7632 are hint NPCs. | Mark 3307; 139,796 XP; 40,000 SP |
| Q230 Test of the Summoner | Galatea 7634; 39; Human/Elven/Dark Wizard | Lara 7063 randomly assigns one of five lists, each requiring 30 + 30 materials and paying two Beginner's Arcanas. Each duel costs one arcana. Defeat the summons of Almors 7635, Camoniell 7636, Belthus 7637, Basilla 7638, Celestiel 7639 and Brynthea 7640 using one unchanged summoned creature per duel. Receive each master's arcana, then return to Galatea. | Mark 3336; 148,409 XP; 30,000 SP |

Drop probabilities and item/template IDs are encoded in the corresponding quest
modules. Trial weapons 3028 and 3029 have quest-specific SQL permissions for
retirement while equipped; other quests cannot consume them from the paperdoll.

## Encounter behavior

- Kadesh and both Dre Vanul phases have personal ownership, deduplicated recovery,
  persisted encounter coordinates, and abort/completion cleanup. Wrong weapons
  do not advance their required-weapon phase. The owning quest NPC offers recovery.
- Summoning duels use personal opponents at the C4 locations. Their six old shared
  world spawns are suppressed; their templates remain available to quest spawning.
- The combat pipeline passes the actual killing actor to quests. Q230 binds the
  actual summoned creature on its first hit, accepts a lethal first hit, rejects
  owner attacks or creature replacement, and receives summon/pet death callbacks.
  Foreign attacks foul the owner's duel without granting the attacker quest credit.
- A lost duel after restart can be conceded at its master. Starting another attempt
  costs another arcana; an expired or restarted encounter never creates a free retry.
- Proofs, quest state and rewards use the existing serialized SQLite transaction.
  Concurrent final hand-ins cannot duplicate marks, XP, SP or diamonds.

## Validation

The reusable walkthroughs drive real QuestService handlers, NPC dialogue links,
inventory, equipment, SQLite reopen and the level-40 transfer. Summoning duels
also drive ReceivedHit → Die → NpcDied using actual summoned NPC objects.
Guards cover class/level/NPC eligibility, all five material lists, independent
branch order, wrong weapons, recovery, foreign interference and abort cleanup.

These are server integration checks. A visual client walkthrough remains a
separate validation step; these changes do not restart or deploy the server.

## Complete route coverage

All 31 routes now have complete server walkthroughs. The final fifteen are:

| Profession | Trials | Marks | Transfer masters |
| --- | --- | --- | --- |
| Dark Avenger | Q212, Q217, Q229 | 2633, 2734, 3307 | 7109, 7187, 7689, 7849, 7900 |
| Shillien Knight | Q212, Q219, Q229 | 2633, 3172, 3307 | 7195, 7699, 7474, 7862, 7910, 8285, 8324, 8328, 8331, 8334 |
| Treasure Hunter | Q213, Q217, Q225 | 2673, 2734, 2809 | 7109, 7187, 7689, 7849, 7900 |
| Plains Walker | Q213, Q218, Q225 | 2673, 3140, 2809 | 7109, 7187, 7689, 7849, 7900 |
| Abyss Walker | Q213, Q219, Q225 | 2673, 3172, 2809 | 7195, 7699, 7474, 7862, 7910, 8285, 8324, 8328, 8331, 8334 |
| Hawkeye | Q213, Q217, Q224 | 2673, 2734, 3293 | 7109, 7187, 7689, 7849, 7900 |
| Silver Ranger | Q213, Q218, Q224 | 2673, 3140, 3293 | 7109, 7187, 7689, 7849, 7900 |
| Phantom Ranger | Q213, Q219, Q224 | 2673, 3172, 3293 | 7195, 7699, 7474, 7862, 7910, 8285, 8324, 8328, 8331, 8334 |
| Sorcerer | Q214, Q217, Q228 | 2674, 2734, 2840 | 7115, 7174, 7176, 7694, 7854 |
| Necromancer | Q214, Q217, Q229 | 2674, 2734, 3307 | 7115, 7174, 7176, 7694, 7854 |
| Warlock | Q214, Q217, Q230 | 2674, 2734, 3336 | 7115, 7174, 7176, 7694, 7854 |
| Spellsinger | Q214, Q218, Q228 | 2674, 3140, 2840 | 7115, 7174, 7176, 7694, 7854 |
| Elemental Summoner | Q214, Q218, Q230 | 2674, 3140, 3336 | 7115, 7174, 7176, 7694, 7854 |
| Spellhowler | Q214, Q219, Q228 | 2674, 3172, 2840 | 7195, 7699, 7474, 7862, 7910, 8285, 8324, 8328, 8331, 8334 |
| Phantom Summoner | Q214, Q219, Q230 | 2674, 3172, 3336 | 7195, 7699, 7474, 7862, 7910, 8285, 8324, 8328, 8331, 8334 |
