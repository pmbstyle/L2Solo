# Soul Crystal progression (C4)

`soul_crystals.json` contains 42 intact crystals (three colors, stages 0–13)
and 110 NPC absorption rules. `Others/c4_soul_crystals.json` adds the nine
previously missing stage 11–13 templates. Broken crystals are 4662–4664.

Regenerate with `python3 scripts/generate-c4-soul-crystals.py [source-directory]`.
Source: [L2J Lisvus](https://gitlab.com/TheDnR/l2j-lisvus), revision
`fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975`, `datapack/data/soulCrystals.xml`,
`datapack/sql/npc.sql`, `SoulCrystalData.java` and `L2MonsterInstance.java`.
The official [C4 patch notes](https://legacy-lineage2.com/news/chronicle4_16.html)
identify Antharas, Valakas, Ember and Anakazel as stage 13 sources.

## Runtime rules

- Quest 350 must be started. Ordinary targets require skill 2096 at no more
  than half HP, then the final hit by that player or their summon. The mark
  records the actual crystal object, so another crystal cannot be substituted.
- Exactly one intact crystal must be carried. All stages, including 13, and
  item amounts count toward resonance. Broken remains do not count.
- Each ordinary NPC has its own maximum stage. Eligible crystals gain one
  stage with 32% probability, break with 10%, and otherwise remain unchanged.
  Quest drop rates do not multiply these probabilities or the resulting item.
- Bosses with maximum stage 12 accept stages 10 and 11; bosses with maximum
  stage 13 accept stage 12. No item use or HP threshold is required. Boss
  failures never break crystals. Stage 13 is terminal.
- The imported bosses use FULL_PARTY. Lilith, Anakim, Baium, Zaken, Antharas
  and Valakas guarantee growth of eligible crystals. Ember and Anakazel use
  70%. LAST_HIT and PARTY_ONE_RANDOM are also handled; random selection happens
  before checking the selected player's crystal or quest, with no reroll.
- Group recipients must be alive, online and within the existing 2500-unit
  party reward radius. This is a local proximity policy; Lisvus does not check
  distance here. The success roll is shared across recipients as in its code.

## Source uncertainty and deliberate fixes

Lisvus explicitly labels its 70% boss chance as an estimate. These values are
the project's compatibility baseline, **not verified retail probabilities**.
Its integer `<=` comparison adds an accidental percentage point; this runtime
uses exact 32% and 70% thresholds. The ordinary-failure comments in that source
also disagree with its constants. We use the constants, not the comments.

Unlike that implementation, we require the active quest, count stacked
amounts and terminal crystals, and evaluate each recipient's item separately.
Session quest mutations serialize rewards with quest exit. SQLite checks the
active quest, ownership, expected item and total crystal quantity in a single
transaction before changing the item template. The object id stays stable for
shortcuts. Failed persistence leaves the original crystal intact. A death
cannot be processed twice; overlapping deaths cannot reuse a replaced item.

The catalog does not create NPCs or encounters. At implementation time 62 of
the 110 targets have runtime templates; Lilith, Anakim, Ember and Antharas are
among them. Baium, Zaken, Valakas, Anakazel and 44 ordinary target templates
are not yet imported. Their rules will apply when those encounters are added.

Verification: `node tests/test_soul_crystal_progression.js` covers every color
and stage transition, failure boundaries, resonance, final-hit ownership,
summons, party eligibility, persistence, death dispatch and cast cancellation.
