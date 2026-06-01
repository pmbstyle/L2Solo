# L2NodeSolo - Offline Solo MMORPG Lineage II C2 Server

**L2NodeSolo** is a highly customized, ultra-fast **Lineage II Chronicle 2 (C2 Splendor)** server emulator written in **Node.js** and backed by **MariaDB**. 

Unlike standard private servers, L2NodeSolo is specifically designed to create an immersive, single-player **Solo MMORPG offline experience** (conceptually similar to *Erenshor*). It populates the game world with active, autonomous **SimPlayers (AI Bots)** that hunt, chat, level up, manage their own economies, and can join your actual in-game party!

> [!NOTE]  
> This project is a heavily expanded fork of the excellent and lightweight **[NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2)**.

---

## 🚀 Key Solo & Bot Features

* **Autonomous SimPlayers (Bots):** Gymnasium for automated AI players! Gimli, Legolas, and Gandalf are online and active from Talk Village. They roam, hunt keltirs, sit down to rest on low HP/MP, go to town to sell loot, buy soulshots, and write dynamically in public chat.
* **1000x Spatial 2D Grid Optimization:** Powered by a high-performance **2D Grid Partitioning System** in `World.js`. By indexing all 27,360 NPC spawns into 5000x5000 sector cells, bot monster queries and player environment visibility checks operate in O(1) complexity, resulting in **virtually 0% CPU usage** even with 50+ active bots!
* **Scalable Procedural Generator:** Populating Talking Island with a massive community of unique players is as easy as changing `EXTRA_BOTS_COUNT = 0` to your desired count (e.g. `30` or `50`) in [BotManager.js](src/GameServer/Bot/BotManager.js). Bots procedurally generate with realistic fantasy names (Geralt, Aragorn, Ciri, Triss, etc.) and class combos.
* **Interactive UI Party HUD & Teleportation:** Target any bot and type `/invite` or click Invite. If the bot is far away (> 500 units), they will dynamically **teleport next to you**, accept in public chat, and **show up directly inside your in-game group HUD sidebar** with active HP/MP bars updating on every AI tick! Type `/leave` or `/dismiss <name>` (or use `.leave`/`.kick` chat commands) to dismiss them back to their farming spots.
* **Live Bag Selling (`.sell`) & Working Shops:** Talking Island merchants Silvia, Silvia, Lector, and Katerina have fully functioning HTML dialogues. Sell unequipped loot directly to them or via the `.sell` command for 50% price, immediately updating your client inventory and Adena stacks in real-time.
* **Gandalf Divine Casting:** Gandalf is programmed to play a casting animation and fully heal your HP/MP whenever you type `heal` or `buff` in nearby public chat!

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

---

## ✴️ In-Game Chat Commands

* `.admin` - Opens the administrative menu (Teleports, Leveling, and full Item Lists).
* `.sell` - Instantly cleans out all unequipped junk loot from your inventory for 50% retail value.
* `.leave` / `/leave` - Dissolves the current companion group, returning bots to their farming fields.
* `.kick <name>` / `/dismiss <name>` - Kicks a specific bot companion from your party.
* Nearby bots will react to chat lines like: `hi`, `follow`, `wait`, `hunt`, and `heal` (Gandalf only).

---

## 📄 License
L2NodeSolo is licensed under the [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0).  
Original L2Node framework credited to [naden](https://github.com/NodeL2/NodeL2).
