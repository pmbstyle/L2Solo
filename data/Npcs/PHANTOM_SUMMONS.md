# Phantom Summoner templates

The 42 templates added for issues #113 and #239 come from
[L2J Lisvus C4 npc.sql](https://gitlab.com/TheDnR/l2j-lisvus/-/blob/fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975/datapack/sql/npc.sql):

- Shadow: `12447`–`12455`, skill levels 10–18, NPC levels 60–76.
- Silhouette: `12456`–`12464`, skill levels 10–18, NPC levels 60–76.
- Soulless: `12503`–`12515` and `12538`, skill levels 1–14, NPC levels 42–76.
- Nightshade: `13165`–`13174`, skill levels 1–10, NPC levels 58–76.

Regenerate with `node scripts/generate-c4-phantom-summons.js` using the pinned
checkout at `tmp/vendor/l2j-lisvus`, or pass its path as the first argument.
The script preserves unrelated entries in `summons.json`.

Levels, attributes, combat stats, vitals, regeneration, movement, collision,
equipment, faction and rewards are copied from the source. `L2Pet` becomes
the runtime's `Summon` kind. Attack variance, accuracy, corpse time and equipment
reuse time use the existing summon defaults because the SQL has no such fields.
Existing lower-level templates and the fallback for other summon families are
unchanged. Summon levels are determined by the learned skill, not the owner level.

`tests/test_summon_runtime.js` verifies exact template coverage and creation for
all 60 skill levels, including source stat anchors at the added ranges' endpoints.

The same generator imports `npcskills.sql` bindings for all 60 templates and the
eight skill definitions from `4100-4199.xml`, `4200-4299.xml`, and `4700-4799.xml` into
`Skills/c4_phantom_summons.json`. These replace legacy bindings for these NPCs:
Shadow's Vampiric Attack, Silhouette's Steal Blood, Soulless's Corpse Burst and
Toxic Smoke, Nightshade's Curse of Shade, Mass Curse of Shade and Shade Sacrifice,
plus Summoned Monster Magic Protection. Race and Contract Payment
are marked `NOTDONE` in the reference and have no executable effect to import.

Runtime checks exercise the native summon commands and actual melee/skill hits:
15% melee absorption, 20% Steal Blood absorption, sourced MP costs and reuse,
rank-scaled poison ticks, and corpse-centered area damage with corpse consumption.
