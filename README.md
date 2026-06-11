# L2NodeSolo - Offline Solo MMORPG Lineage II C2 Server

**L2NodeSolo** is a highly customized, ultra-fast **Lineage II Chronicle 2 (C2 Splendor)** server emulator written in **Node.js** and backed by **MariaDB**. 

Unlike standard private servers, L2NodeSolo is specifically designed to create an immersive, single-player **Solo MMORPG offline experience** (conceptually similar to *Erenshor*). It populates the game world with active, autonomous **SimPlayers (AI Bots)** that hunt, chat, level up, manage their own economies, and can join your actual in-game party!

> [!NOTE]  
> This project is a heavily expanded fork of the excellent and lightweight **[NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2)**.

---

## 🚀 Key Solo & Bot Features

* **Player-Centric Dynamic Spawner:** Instead of rendering bots across empty zones of the world, a background monitor dynamics checks coordinates and spawns/anchors bots directly around active players (within a 2500-unit radius). This creates an extremely dense, alive, and packed MMO atmosphere while keeping CPU and RAM footprint extremely low.
* **Real-Time Level & Stats Scaling:** All automated bots automatically adapt their level to match the active player's level (`playerLevel ± 1`). When the player gains a level, nearby bots celebrate with a social action flare and scale their stats (Max HP/MP, P.Atk, P.Def, Atk.Spd, and Cast.Spd) instantly according to the retail Formulas, replenishing their vitals in real time!
* **Autonomous SimPlayers (Bots) & Shopping State:** SimPlayers are fully self-sufficient. They roam, hunt, rest to regenerate, chat dynamically, and periodically return to town when their inventory is full to sell junk loot (`sell-junk` NPC bypass) and restock on No-Grade Soulshots.
* **PK Bots & Random Coordinate Respawn:** Watch out for PK (Player Killer) bots like **Aragorn** that roam, scale, and hunt players! To prevent bots and players from death-looping in a pile, a random coordinate respawn scatter system disperses resurrected bots across dynamic coordinates around the zone.
* **High-Performance Soulshots:** Completely revamped synchronous-in-memory soulshots system. Using a soulshot manually or relying on the automatic attack consume triggers memory updates, UI visual flashes (Skill `2039` weapon glow effect), and **2.0x physical attack damage** instantly. Heavy database writes are executed asynchronously in the background, ensuring 0ms latency and a buttery smooth combat loop.
* **Party HUD Companion System:** Target any bot and type `/invite` to summon them to your party. Companions dynamically teleport to your location, accept the invite with chat flavor text, and join the party HUD sidebar with active, real-time HP/MP bars!
* **Town Helpers & Divine Actions:** Talk Village town helpers and unique AI bots like Gandalf will react to public chat keywords. Typing `heal` or `buff` near Gandalf prompts him to instantly cast restoration spells on your character.
* **Instant Sell Bypass (`.sell`):** Sell your unequipped loot in town dialogues or instantly via the `.sell` console command, giving you 50% retail Adena value instantly to keep your farming runs fast and rewarding.

---

## 🛠️ Prerequisites

* Install **[NodeJS LTS](https://nodejs.org/en/download)**, and **Docker** (to run MariaDB in a lightweight container).
* For convenience, install **[VS Code](https://code.visualstudio.com/download)**.
* Download the **[LINEAGE II C2 Splendor Client (Protocol 485)](https://drive.google.com/file/d/1NVA4XY3bC2xD_Jejggo_b0fuMFChsZqe/view?usp=sharing)**.

---

## 💻 Quick Start

### 1. Start the MariaDB Docker Container
Start a clean MariaDB 10.6 container mapping standard port `3306`:
```bash
docker run -d --name nodel2-mariadb -p 3306:3306 -e MARIADB_ROOT_PASSWORD='alosi!$53' mariadb:10.6
```

### 2. Import the Database
Import the Chronicle 2 table structures:
```bash
Get-Content database/sql/database.sql -Raw | docker exec -i nodel2-mariadb mariadb -u root -palosi!$53
```

### 3. Install Sockets & Dependencies
Install Node packages:
```bash
npm install
```

### 4. Boot the Server
Launch the Game and Login servers:
```bash
npm run NodeL2
```
*The spatial grid will index the spawns at boot, and bots will automatically load from database accounts and spawn beside Talk Village town center within 5 seconds!*

### Optional: OpenRouter Bot Brain
The committed `config/default.ini` contains safe defaults only. Put private overrides in ignored `config/local.ini`:
```ini
[OpenRouter]
enabled = true
apiKey = sk-or-v1-your-key-here
model = google/gemini-2.5-flash-lite
debug = true
```
You can also use environment variables instead of a local file:
```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here npm run NodeL2
```
With `debug = true`, BotBrain logs why it skips a request (`disabled`, `missing_api_key`, `no_visible_real_players`, `cooldown`) or when it sends a decision request. The brain only runs for bots visible to a real player.

---

## ✴️ In-Game Chat Commands

* `.admin` - Opens the administrative menu (Teleports, Leveling, and full Item Lists).
* `.sell` - Instantly cleans out all unequipped junk loot from your inventory for 50% retail value.
* `.leave` / `/leave` - Dissolves the current companion group, returning bots to their farming fields.
* `.kick <name>` / `/dismiss <name>` - Kicks a specific bot companion from your party.
* Nearby bots will react to chat lines like: `hi`, `follow`, `wait`, `hunt`, and `heal` (Gandalf only).

---

## 🧪 Debug Notes

* C2 Buy store nameplate opcode probe: `0xAE` reacts/crashes with bad payload, but safe payload is `objectId + byte(0)`.
* Spell-cancel overlay effect trick: inserting a `writeS(title)` after `CharInfo.privateStoreType` shifts client parsing into effect/status fields and renders the cancel-spell overlay above the character. Do **not** use this for store text; restore CharInfo structure afterward.

---

## 📄 License
L2NodeSolo is licensed under the [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0).  
Original L2Node framework credited to [naden](https://github.com/NodeL2/NodeL2).
