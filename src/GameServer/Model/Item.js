const inventoryOwners = new WeakMap();
const inventoryBindings = new WeakMap();

class ItemModel {
    constructor(data) {
        this.model = data;
    }

    // Set

    setId(data) {
        this.model.id = data;
    }

    setAmount(data) {
        const changed = this.model.amount !== data;
        this.model.amount = data;
        const binding = inventoryOwners.get(this);
        if (changed && binding && inventoryBindings.get(binding.backpack) === binding
            && binding.backpack.items === binding.items && binding.items.length === binding.count
            && binding.members.has(this)) {
            binding.backpack.inventoryRevision = Number(binding.backpack.inventoryRevision || 0) + 1;
            binding.backpack.onInventoryChange?.();
        }
    }

    static bindInventory(backpack, items = backpack.fetchItems()) {
        const previous = inventoryBindings.get(backpack);
        if (previous?.items === items && previous.count === items.length) return;
        const binding = { backpack, items, count: items.length, members: new Set(items) };
        inventoryBindings.set(backpack, binding);
        for (const item of items) inventoryOwners.set(item, binding);
    }

    setEnchantLevel(data) {
        const next = Math.max(0, Number(data) || 0);
        const changed = this.model.enchant !== next;
        this.model.enchant = next;
        const binding = inventoryOwners.get(this);
        if (changed && binding && inventoryBindings.get(binding.backpack) === binding
            && binding.backpack.items === binding.items && binding.items.length === binding.count
            && binding.members.has(this)) {
            binding.backpack.inventoryRevision = Number(binding.backpack.inventoryRevision || 0) + 1;
            binding.backpack.onInventoryChange?.();
        }
    }

    setPetData(data) {
        this.model.petData = data;
    }

    // Get

    fetchId() {
        return this.model.id ?? 0;
    }

    fetchSelfId() {
        return this.model.selfId ?? 0;
    }

    fetchName() {
        return this.model.name ?? '';
    }

    fetchKind() {
        return this.model.kind ?? '';
    }

    fetchOwner() {
        return this.model.characterId ?? 0;
    }

    fetchAmount() {
        return this.model.amount ?? 1;
    }

    fetchEnchantLevel() {
        return Math.max(0, Number(this.model.enchant ?? 0) || 0);
    }

    fetchClass1() {
        return this.model.class1 ?? 0;
    }

    fetchClass2() {
        return this.model.class2 ?? 0;
    }

    fetchMass() {
        return this.model.mass ?? 0;
    }

    fetchPrice() {
        return this.model.price ?? 0;
    }

    fetchLocX() {
        return this.model.locX ?? 0;
    }

    fetchLocY() {
        return this.model.locY ?? 0;
    }

    fetchLocZ() {
        return this.model.locZ ?? 0;
    }

    fetchPetData() {
        if (typeof this.model.petData === 'string') {
            try {
                return JSON.parse(this.model.petData);
            } catch (err) {
                return null;
            }
        }
        return this.model.petData || null;
    }

    // Abstract

    isWearable() {
        return ['Armor', 'Weapon'].includes(this.fetchKind().split('.')[0]);
    }

    isArmor() {
        return this.fetchKind().includes('Armor');
    }

    isWeapon() {
        return this.fetchKind().includes('Weapon');
    }
}

module.exports = ItemModel;
