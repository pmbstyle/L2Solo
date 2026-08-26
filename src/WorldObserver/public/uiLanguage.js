(function initWorldObserverUiLanguage(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.WorldObserverUiLanguage = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
    const LABELS = Object.freeze({
        status: Object.freeze({
            active: 'Active',
            blocked: 'Blocked',
            cancelled: 'Cancelled',
            complete: 'Completed',
            completed: 'Completed',
            executing: 'In progress',
            failed: 'Blocked',
            idle: 'Idle',
            pending: 'Queued',
            paused: 'Paused',
            running: 'Running',
            succeeded: 'Completed'
        }),
        type: Object.freeze({
            adena: 'Adena',
            equipment: 'Equipment',
            item: 'Item',
            operation: 'Operation'
        }),
        plan: Object.freeze({
            contribution: 'Contribution',
            craft: 'Crafting',
            farm: 'Farming',
            goal_plan: 'Goal planning',
            market: 'Market',
            party: 'Party operation',
            prepare: 'Party preparation',
            warehouse: 'Warehouse'
        }),
        reason: Object.freeze({
            clan_equipment_craft: 'Crafting clan gear',
            clan_equipment_farm: 'Farming clan gear',
            clan_equipment_market: 'Buying clan gear',
            clan_equipment_prepare: 'Preparing a clan party',
            clan_order_delivered: 'Delivered to member',
            farm_source_selected: 'Drop source selected',
            goal_completed: 'Goal completed',
            item_source_unavailable: 'No known drop source',
            item_level_up: 'Member level increased',
            market_demand_open: 'Market request opened',
            market_no_offer: 'No suitable offer',
            market_offer_available: 'Offer available',
            market_offer_unavailable: 'Waiting for an offer',
            no_equipment_beneficiary: 'No compatible upgrade found',
            party_not_ready: 'Party not ready',
            party_operation_started: 'Clan party deployed',
            party_operation_succeeded: 'Clan operation completed',
            party_ready: 'Party ready',
            player_managed_sync: 'Player clan synced',
            player_order_cancel: 'Order cancelled',
            player_order_pause: 'Order paused',
            player_order_replan: 'Order replanned',
            player_order_resume: 'Order resumed',
            stale_snapshot: 'World state changed',
            terminal_level: 'Maximum clan level reached',
            warehouse_delivery_pending: 'Waiting to deliver',
            warehouse_progress: 'Warehouse progress'
        }),
        event: Object.freeze({
            action_failed: 'Action blocked',
            action_succeeded: 'Action completed',
            equipment_goal_advanced: 'Gear goal advanced',
            equipment_goal_created: 'Gear goal created',
            equipment_goal_updated: 'Gear goal updated',
            goal_completed: 'Goal completed',
            goal_created: 'Goal created',
            goal_plan_selected: 'Plan selected',
            goal_progress: 'Goal progress',
            party_operation_started: 'Operation started',
            party_operation_succeeded: 'Operation completed',
            party_roster_refreshed: 'Party roster refreshed',
            player_order_cancelled: 'Order cancelled',
            player_order_completed: 'Order completed',
            player_order_created: 'Order created',
            player_order_paused: 'Order paused',
            player_order_progress: 'Order progress',
            player_order_replanned: 'Order replanned',
            player_order_resumed: 'Order resumed'
        }),
        strategy: Object.freeze({
            craft: 'Crafting',
            direct_drop: 'Direct drop',
            farm: 'Farming',
            market: 'Market'
        })
    });

    function humanize(value, fallback = '—') {
        if (value === null || value === undefined || value === '') return fallback;
        const raw = String(value).trim();
        const looksLikeCode = /[_-]/.test(raw) || /[a-z0-9][A-Z]/.test(raw) || !/\s/.test(raw);
        if (!looksLikeCode || /^[A-Z0-9.]+$/.test(raw)) return raw || fallback;
        const words = raw
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replaceAll('_', ' ')
            .replaceAll('-', ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
            .replace(/\bone handed\b/g, 'one-handed');
        return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback;
    }

    function label(group, value, fallback = '—') {
        if (value === null || value === undefined || value === '') return fallback;
        return LABELS[group]?.[String(value)] || humanize(value, fallback);
    }

    return { LABELS, humanize, label };
});
