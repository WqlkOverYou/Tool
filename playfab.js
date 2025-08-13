// playfab.js
// PlayFab admin tools: pf-panel (actions + approvals) and pf-account (account standings + notes).
// Stays self-contained and DOES NOT touch your ticket logic.

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

const Store = require('./playfabStore');

// ──────────────────────────────────────────────────────────────────────────────
// Constants / helpers
// ──────────────────────────────────────────────────────────────────────────────
const PFID_RE = /^[A-Z0-9]{16}$/i;
const STEAM64_RE = /^\d{17}$/;
const STEAM_PROFILE_ID_RE = /steamcommunity\.com\/profiles\/(\d{17})/i;
const STEAM_PROFILE_VANITY_RE = /steamcommunity\.com\/id\/([^\/?#]+)/i;

function requireFetch() {
    if (typeof fetch !== 'function') {
        throw new Error('Global fetch is not available. Use Node 18+ or a fetch polyfill.');
    }
}
function pfBaseUrl(titleId) { return `https://${titleId}.playfabapi.com`; }

async function pfAdmin(titleId, secret, path, body) {
    requireFetch();
    const res = await fetch(`${pfBaseUrl(titleId)}/Admin/${path}`, {
        method: 'POST',
        headers: { 'X-SecretKey': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
        const code = json.errorCode || json.code || res.status;
        const msg = json.errorMessage || json.message || 'PlayFab Admin error';
        throw new Error(`PlayFab Admin/${path} failed: ${msg} [${code}]`);
    }
    return json;
}
async function pfServer(titleId, secret, path, body) {
    requireFetch();
    const res = await fetch(`${pfBaseUrl(titleId)}/Server/${path}`, {
        method: 'POST',
        headers: { 'X-SecretKey': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
        const code = json.errorCode || json.code || res.status;
        const msg = json.errorMessage || json.message || 'PlayFab Server error';
        throw new Error(`PlayFab Server/${path} failed: ${msg} [${code}]`);
    }
    return json;
}

function coalesceConfig(passed) {
    if (passed) return passed;
    try { return require('./config.json'); } catch { return {}; }
}

function isAdmin(userId, cfg) {
    const configured = (cfg.OnlyBOTAdmin ?? '').toString().trim();
    return !!configured && userId?.toString() === configured;
}

// durations
function parseHours(input) {
    const s = String(input || '').trim().toLowerCase();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const m = s.match(/^(\d+)([mhdw])$/);
    if (!m) throw new Error('Invalid duration. Use hours or 90m/2h/3d/1w.');
    const n = parseInt(m[1], 10);
    return m[2] === 'm' ? Math.ceil(n / 60)
        : m[2] === 'h' ? n
            : m[2] === 'd' ? n * 24
                : m[2] === 'w' ? n * 168
                    : 0;
}
function toISOFromDur(input) {
    const s = String(input || '').trim().toLowerCase();
    let ms = 0;
    if (/^\d+$/.test(s)) { ms = parseInt(s, 10) * 3_600_000; }
    else {
        const m = s.match(/^(\d+)([mhdw])$/);
        if (!m) throw new Error('Invalid duration. Use 90m/2h/3d/1w or hours.');
        const n = parseInt(m[1], 10);
        ms = m[2] === 'm' ? n * 60_000
            : m[2] === 'h' ? n * 3_600_000
                : m[2] === 'd' ? n * 86_400_000
                    : m[2] === 'w' ? n * 604_800_000
                        : 0;
    }
    return new Date(Date.now() + ms).toISOString();
}

async function resolveVanityToSteam64(vanity, steamWebApiKey) {
    if (!steamWebApiKey) throw new Error('steamWebApiKey missing in config.');
    requireFetch();
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(steamWebApiKey)}&vanityurl=${encodeURIComponent(vanity)}`;
    const res = await fetch(url);
    const json = await res.json();
    const ok = json?.response?.success === 1 && json.response.steamid;
    if (!ok) throw new Error('Could not resolve Steam vanity URL.');
    return json.response.steamid;
}

// Steam64 → PlayFabId with robust fallback
async function getPlayFabIdFromSteam64(steam64, cfgMaybe) {
    const cfg = coalesceConfig(cfgMaybe);
    let json;
    try {
        json = await pfServer(cfg.playfabTitleId, cfg.playfabSecret, 'GetPlayFabIDsFromSteamIDs', { SteamStringIDs: [steam64] });
    } catch {
        json = await pfServer(cfg.playfabTitleId, cfg.playfabSecret, 'GetPlayFabIDsFromSteamIDs', { SteamIDs: [steam64] });
    }
    const arr = json?.data?.Data || json?.Data || json?.data?.data || [];
    const row = Array.isArray(arr)
        ? arr.find(r => (r.SteamStringId || r.SteamId) === steam64) || arr[0]
        : null;
    const pfid = row?.PlayFabId;
    if (!pfid) throw new Error('SteamID64 not linked to a PlayFab account.');
    return pfid;
}

// Accepts: PlayFabId, SteamID64, or steamcommunity profile URL
async function resolvePlayerFromInput(input, cfgMaybe) {
    const cfg = coalesceConfig(cfgMaybe);
    const raw = String(input || '').trim();
    if (!raw) throw new Error('No lookup identifier specified [1000].');

    if (PFID_RE.test(raw)) return { playFabId: raw.toUpperCase() };

    const mId = raw.match(STEAM_PROFILE_ID_RE);
    if (mId) {
        const steam64 = mId[1];
        const p = await getPlayFabIdFromSteam64(steam64, cfg);
        return { playFabId: p, steam64 };
    }
    const mVan = raw.match(STEAM_PROFILE_VANITY_RE);
    if (mVan) {
        const vanity = decodeURIComponent(mVan[1]);
        const steam64 = await resolveVanityToSteam64(vanity, cfg.steamWebApiKey);
        const p = await getPlayFabIdFromSteam64(steam64, cfg);
        return { playFabId: p, steam64, vanity };
    }
    if (STEAM64_RE.test(raw)) {
        const p = await getPlayFabIdFromSteam64(raw, cfg);
        return { playFabId: p, steam64: raw };
    }
    throw new Error('Unsupported identifier. Use PlayFabId, a 17-digit SteamID64, or a Steam profile URL.');
}

// ──────────────────────────────────────────────────────────────────────────────
// pf-panel (actions + approvals) — unchanged behavior from previous version
// ──────────────────────────────────────────────────────────────────────────────
function pfPanelCommand() {
    return new SlashCommandBuilder()
        .setName('pf-panel')
        .setDescription('Open the PlayFab admin panel (secure approvals for testers).');
}

async function postPanel(inter, cfgMaybe) {
    const cfg = coalesceConfig(cfgMaybe);

    const emb = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle('⚙️ PlayFab Administration')
        .setDescription(
            'Use this panel to **Ban**, **Mute (Vivox)**, or **Reset** a player account.\n' +
            'Paste any of: **PlayFabId**, **SteamID64**, or **Steam profile URL** (`/profiles/<id>` or `/id/<vanity>`).'
        )
        .addFields(
            {
                name: 'Security', value: isAdmin(inter.user.id, cfg)
                    ? 'You are recognized as **Admin** — actions will execute immediately.'
                    : 'You are a **QA tester** — your requests will be queued for admin approval in a private channel.',
                inline: false
            },
            { name: 'Note', value: 'Steam vanity lookups require `steamWebApiKey` in config.', inline: false }
        )
        .setFooter({ text: 'OUTBRK • PlayFab Tools' });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf|ban').setLabel('Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
        new ButtonBuilder().setCustomId('pf|mute').setLabel('Mute (Vivox)').setStyle(ButtonStyle.Primary).setEmoji('🔇'),
        new ButtonBuilder().setCustomId('pf|reset').setLabel('Reset Account').setStyle(ButtonStyle.Secondary).setEmoji('♻️')
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf|mine').setLabel('My Requests').setStyle(ButtonStyle.Secondary).setEmoji('🗂')
    );

    return inter.reply({ ephemeral: true, embeds: [emb], components: [row1, row2] });
}

// UI helpers (keep label <= 45)
function idInput(label = 'ID (PlayFabId/Steam64/URL)') {
    return new TextInputBuilder()
        .setCustomId('id').setLabel(label)
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256);
}
function txtInput(id, label, placeholder = '', paragraph = false, required = true) {
    return new TextInputBuilder()
        .setCustomId(id).setLabel(label)
        .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(required).setPlaceholder(placeholder);
}

// Buttons for pf-panel (approvals + modals)
async function handleButton(inter, cfgMaybe) {
    if (!inter.customId?.startsWith('pf|')) return;
    const cfg = coalesceConfig(cfgMaybe);

    // Approvals buttons (admin only)
    if (inter.customId.startsWith('pf|approve|') || inter.customId.startsWith('pf|reject|') || inter.customId.startsWith('pf|edit|')) {
        if (!isAdmin(inter.user.id, cfg)) return inter.reply({ ephemeral: true, content: '❌ Not authorized.' });
        const [, action, pendingId] = inter.customId.split('|');
        const pending = Store.getPending(pendingId);
        if (!pending) return inter.reply({ ephemeral: true, content: '❌ Pending request not found or already processed.' });

        if (action === 'approve') {
            await inter.deferReply({ ephemeral: true });
            const res = await executePending(pending, inter.user.id, cfg);
            Store.removePending(pendingId);
            await finalizeApprovalMessage(inter.message, `✅ Approved by <@${inter.user.id}> — ${res}`, true);
            await safeDM(pending.requestedBy, `✅ Your PlayFab request **${pending.type}** was approved.`);
            return inter.editReply({ content: 'Approved & executed.' });
        }

        if (action === 'reject') {
            Store.removePending(pendingId);
            Store.addHistory({
                id: Store.newId(),
                type: pending.type,
                playFabId: pending.playFabId,
                reason: pending.reason,
                duration: pending.duration,
                expiresAt: pending.expiresAt,
                requestedBy: pending.requestedBy,
                approvedBy: inter.user.id,
                status: 'rejected',
                executedAt: new Date().toISOString()
            });
            await finalizeApprovalMessage(inter.message, `❌ Rejected by <@${inter.user.id}>.`, true);
            await safeDM(pending.requestedBy, `❌ Your PlayFab request **${pending.type}** was rejected.`);
            return inter.reply({ ephemeral: true, content: 'Rejected.' });
        }

        if (action === 'edit') {
            const modal = new ModalBuilder().setCustomId(`pf|edit_modal|${pendingId}`).setTitle(`Edit & Approve — ${pending.type}`);
            if (pending.type === 'ban' || pending.type === 'mute') {
                modal.addComponents(
                    new ActionRowBuilder().addComponents(txtInput('reason', 'Reason', pending.reason || '')),
                    new ActionRowBuilder().addComponents(txtInput('duration', 'Duration (hours or 90m/2h/3d/1w)', pending.duration || ''))
                );
            } else {
                modal.addComponents(new ActionRowBuilder().addComponents(txtInput('noop', 'No editable fields for reset', '', false, false)));
            }
            return inter.showModal(modal);
        }
        return;
    }

    // "My Requests" panel (ephemeral list)
    if (inter.customId === 'pf|mine') {
        const mine = Store.listPendingByRequester(inter.user.id);
        if (!mine.length) return inter.reply({ ephemeral: true, content: 'You have no pending requests.' });
        const emb = new EmbedBuilder()
            .setTitle('🗂 My Pending Requests')
            .setColor(0x374151)
            .setDescription(mine.map(r =>
                `• **${r.type}** for \`${r.playFabId || r.input}\` — id \`${r.id}\` • requested ${new Date(r.requestedAt).toLocaleString()}`
            ).join('\n'));
        return inter.reply({ ephemeral: true, embeds: [emb] });
    }

    // Open modals for actions (QA + Admin)
    if (inter.customId === 'pf|ban') {
        const modal = new ModalBuilder().setCustomId('pf|ban_modal').setTitle('PlayFab Ban');
        modal.addComponents(
            new ActionRowBuilder().addComponents(idInput()),
            new ActionRowBuilder().addComponents(txtInput('reason', 'Reason', 'e.g. Cheating', true, true)),
            new ActionRowBuilder().addComponents(txtInput('duration', 'Duration (hours or 90m/2h/3d/1w)', 'e.g. 168')),
            new ActionRowBuilder().addComponents(txtInput('confirm', 'Type YES to confirm', '', false, true)),
        );
        return inter.showModal(modal);
    }
    if (inter.customId === 'pf|mute') {
        const modal = new ModalBuilder().setCustomId('pf|mute_modal').setTitle('Vivox Mute (PlayFab)');
        modal.addComponents(
            new ActionRowBuilder().addComponents(idInput()),
            new ActionRowBuilder().addComponents(txtInput('reason', 'Reason', 'e.g. Inappropriate language', true, true)),
            new ActionRowBuilder().addComponents(txtInput('duration', 'Duration (90m/2h/3d/1w or hours)', 'e.g. 7d')),
            new ActionRowBuilder().addComponents(txtInput('confirm', 'Type YES to confirm', '', false, true)),
        );
        return inter.showModal(modal);
    }
    if (inter.customId === 'pf|reset') {
        const modal = new ModalBuilder().setCustomId('pf|reset_modal').setTitle('Reset Account (Delete Save)');
        modal.addComponents(
            new ActionRowBuilder().addComponents(idInput()),
            new ActionRowBuilder().addComponents(txtInput('confirm', 'Type YES to confirm', '', false, true)),
        );
        return inter.showModal(modal);
    }
}

// Modals for pf-panel
async function handleModal(inter, cfgMaybe) {
    if (!inter.customId?.startsWith('pf|')) return;
    const cfg = coalesceConfig(cfgMaybe);

    // Admin edit-and-approve flow
    if (inter.customId.startsWith('pf|edit_modal|')) {
        if (!isAdmin(inter.user.id, cfg)) return inter.reply({ ephemeral: true, content: '❌ Not authorized.' });
        const [, , pendingId] = inter.customId.split('|');
        const pending = Store.getPending(pendingId);
        if (!pending) return inter.reply({ ephemeral: true, content: '❌ Pending request not found.' });

        if (pending.type === 'ban' || pending.type === 'mute') {
            pending.reason = inter.fields.getTextInputValue('reason')?.trim() || pending.reason;
            pending.duration = inter.fields.getTextInputValue('duration')?.trim() || pending.duration;
            if (pending.type === 'mute') pending.expiresAt = toISOFromDur(pending.duration);
        }
        Store.updatePending(pending);

        await inter.deferReply({ ephemeral: true });
        const res = await executePending(pending, inter.user.id, cfg);
        Store.removePending(pendingId);
        await finalizeApprovalMessage(inter.message, `✅ Edited & approved by <@${inter.user.id}> — ${res}`, true);
        await safeDM(pending.requestedBy, `✅ Your PlayFab request **${pending.type}** was approved (with edits).`);
        return inter.editReply({ content: 'Edited, approved & executed.' });
    }

    try {
        // BAN
        if (inter.customId === 'pf|ban_modal') {
            const id = inter.fields.getTextInputValue('id');
            const reason = inter.fields.getTextInputValue('reason')?.trim();
            const durationRaw = inter.fields.getTextInputValue('duration')?.trim();
            const confirm = inter.fields.getTextInputValue('confirm')?.trim().toUpperCase();
            if (confirm !== 'YES') throw new Error('2FA confirmation failed (type YES).');

            const { playFabId, steam64, vanity } = await resolvePlayerFromInput(id, cfg);
            if (isAdmin(inter.user.id, cfg)) {
                const hours = durationRaw ? parseHours(durationRaw) : 0;
                await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'BanUsers', {
                    Bans: [{ PlayFabId: playFabId, Reason: reason || 'No reason provided', DurationInHours: Math.max(0, hours) }]
                });
                Store.addHistory({
                    id: Store.newId(), type: 'ban', playFabId, reason, duration: durationRaw || '0',
                    requestedBy: inter.user.id, approvedBy: inter.user.id, status: 'executed',
                    executedAt: new Date().toISOString(), steam64, vanity
                });
                return inter.reply({ ephemeral: true, content: `✅ Banned **${playFabId}** (${durationRaw || '0'}h).` });
            }
            const pending = {
                id: Store.newId(),
                type: 'ban',
                playFabId, steam64, vanity,
                reason, duration: durationRaw || '0',
                requestedBy: inter.user.id,
                requestedAt: new Date().toISOString(),
                input: id
            };
            return queueForApproval(inter, pending, cfg);
        }

        // MUTE
        if (inter.customId === 'pf|mute_modal') {
            const id = inter.fields.getTextInputValue('id');
            const reason = inter.fields.getTextInputValue('reason')?.trim();
            const durationRaw = inter.fields.getTextInputValue('duration')?.trim();
            const confirm = inter.fields.getTextInputValue('confirm')?.trim().toUpperCase();
            if (confirm !== 'YES') throw new Error('2FA confirmation failed (type YES).');
            if (!reason) throw new Error('Reason is required for Vivox mute.');
            if (!durationRaw) throw new Error('Duration is required for Vivox mute.');

            const { playFabId, steam64, vanity } = await resolvePlayerFromInput(id, cfg);
            if (isAdmin(inter.user.id, cfg)) {
                const expiresAt = toISOFromDur(durationRaw);
                let existing = {};
                try {
                    const read = await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'GetUserReadOnlyData',
                        { PlayFabId: playFabId, Keys: ['Additional Data'] });
                    const raw = read?.data?.Data?.['Additional Data']?.Value;
                    if (raw) existing = JSON.parse(raw);
                } catch { }
                const updated = { ...(existing || {}), vivoxBan: { reason, expiresAt } };
                await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'UpdateUserReadOnlyData', {
                    PlayFabId: playFabId,
                    Data: { 'Additional Data': JSON.stringify(updated) },
                    Permission: 'Public'
                });
                Store.addHistory({
                    id: Store.newId(), type: 'mute', playFabId, reason, duration: durationRaw,
                    expiresAt, requestedBy: inter.user.id, approvedBy: inter.user.id, status: 'executed',
                    executedAt: new Date().toISOString(), steam64, vanity
                });
                return inter.reply({ ephemeral: true, content: `✅ Vivox mute set for **${playFabId}** until **${expiresAt}**.` });
            }
            const pending = {
                id: Store.newId(), type: 'mute',
                playFabId, steam64, vanity,
                reason, duration: durationRaw, expiresAt: toISOFromDur(durationRaw),
                requestedBy: inter.user.id, requestedAt: new Date().toISOString(), input: id
            };
            return queueForApproval(inter, pending, cfg);
        }

        // RESET
        if (inter.customId === 'pf|reset_modal') {
            const id = inter.fields.getTextInputValue('id');
            const confirm = inter.fields.getTextInputValue('confirm')?.trim().toUpperCase();
            if (confirm !== 'YES') throw new Error('2FA confirmation failed (type YES).');

            const { playFabId, steam64, vanity } = await resolvePlayerFromInput(id, cfg);
            if (isAdmin(inter.user.id, cfg)) {
                await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'UpdateUserData',
                    { PlayFabId: playFabId, KeysToRemove: ['Save'] });
                Store.addHistory({
                    id: Store.newId(), type: 'reset', playFabId,
                    requestedBy: inter.user.id, approvedBy: inter.user.id, status: 'executed',
                    executedAt: new Date().toISOString(), steam64, vanity
                });
                return inter.reply({ ephemeral: true, content: `✅ Account reset for **${playFabId}** (deleted key \`Save\`).` });
            }
            const pending = {
                id: Store.newId(), type: 'reset',
                playFabId, steam64, vanity,
                requestedBy: inter.user.id, requestedAt: new Date().toISOString(), input: id
            };
            return queueForApproval(inter, pending, cfg);
        }
    } catch (err) {
        return inter.reply({ ephemeral: true, content: `❌ PlayFab error: ${err.message}` }).catch(() => { });
    }
}

// Approvals helpers
async function queueForApproval(inter, pending, cfg) {
    const channelId = cfg.playfabApprovalChannelId;
    if (!channelId) return inter.reply({ ephemeral: true, content: '❌ playfabApprovalChannelId not set in config.json' });

    Store.addPending(pending);

    const ch = await inter.client.channels.fetch(channelId).catch(() => null);
    if (!ch) return inter.reply({ ephemeral: true, content: '❌ Approval channel not found.' });

    const emb = new EmbedBuilder()
        .setColor(0x1f2937)
        .setTitle(`Pending • ${pending.type.toUpperCase()}`)
        .addFields(
            { name: 'Requester', value: `<@${pending.requestedBy}>`, inline: true },
            { name: 'When', value: new Date(pending.requestedAt).toLocaleString(), inline: true },
            { name: 'Target', value: `PFID: \`${pending.playFabId}\`${pending.steam64 ? `\nSteam64: \`${pending.steam64}\`` : ''}${pending.vanity ? `\nVanity: \`${pending.vanity}\`` : ''}` },
            ...(pending.reason ? [{ name: 'Reason', value: pending.reason }] : []),
            ...(pending.duration ? [{ name: 'Duration', value: pending.duration }] : []),
        )
        .setFooter({ text: `Request ID: ${pending.id}` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pf|approve|${pending.id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`pf|edit|${pending.id}`).setLabel('Edit & Approve').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId(`pf|reject|${pending.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger).setEmoji('🛑')
    );

    await ch.send({ embeds: [emb], components: [row] });
    return inter.reply({ ephemeral: true, content: `📝 Request queued for admin approval (ID: \`${pending.id}\`).` });
}
async function executePending(pending, approverId, cfg) {
    if (pending.type === 'ban') {
        const hours = pending.duration ? parseHours(pending.duration) : 0;
        await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'BanUsers', {
            Bans: [{ PlayFabId: pending.playFabId, Reason: pending.reason || 'No reason provided', DurationInHours: Math.max(0, hours) }]
        });
        Store.addHistory({
            id: Store.newId(), type: 'ban', playFabId: pending.playFabId,
            reason: pending.reason, duration: pending.duration || '0',
            requestedBy: pending.requestedBy, approvedBy: approverId, status: 'executed',
            executedAt: new Date().toISOString(), steam64: pending.steam64, vanity: pending.vanity
        });
        return `Banned **${pending.playFabId}** (${pending.duration || '0'}h)`;
    }
    if (pending.type === 'mute') {
        const expiresAt = pending.expiresAt || toISOFromDur(pending.duration || '0h');
        let existing = {};
        try {
            const read = await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'GetUserReadOnlyData',
                { PlayFabId: pending.playFabId, Keys: ['Additional Data'] });
            const raw = read?.data?.Data?.['Additional Data']?.Value;
            if (raw) existing = JSON.parse(raw);
        } catch { }
        const updated = { ...(existing || {}), vivoxBan: { reason: pending.reason || '', expiresAt } };
        await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'UpdateUserReadOnlyData', {
            PlayFabId: pending.playFabId,
            Data: { 'Additional Data': JSON.stringify(updated) },
            Permission: 'Public'
        });
        Store.addHistory({
            id: Store.newId(), type: 'mute', playFabId: pending.playFabId,
            reason: pending.reason, duration: pending.duration, expiresAt,
            requestedBy: pending.requestedBy, approvedBy: approverId, status: 'executed',
            executedAt: new Date().toISOString(), steam64: pending.steam64, vanity: pending.vanity
        });
        return `Muted **${pending.playFabId}** until **${expiresAt}**`;
    }
    if (pending.type === 'reset') {
        await pfAdmin(cfg.playfabTitleId, cfg.playfabSecret, 'UpdateUserData',
            { PlayFabId: pending.playFabId, KeysToRemove: ['Save'] });
        Store.addHistory({
            id: Store.newId(), type: 'reset', playFabId: pending.playFabId,
            requestedBy: pending.requestedBy, approvedBy: approverId, status: 'executed',
            executedAt: new Date().toISOString(), steam64: pending.steam64, vanity: pending.vanity
        });
        return `Reset **${pending.playFabId}** (deleted key \`Save\`)`;
    }
    throw new Error('Unknown pending type.');
}
async function finalizeApprovalMessage(message, resultText, disable) {
    try {
        const comps = disable ? message.components.map(row => {
            const r = ActionRowBuilder.from(row);
            r.components = r.components.map(b => ButtonBuilder.from(b).setDisabled(true));
            return r;
        }) : message.components;
        await message.edit({ content: resultText, components: comps });
    } catch { }
}
async function safeDM(userId, content) {
    try {
        const user = await globalThis.client?.users?.fetch?.(userId);
        if (user) await user.send(content);
    } catch { }
}

// ──────────────────────────────────────────────────────────────────────────────
// NEW: pf-account (standings + notes)
// ──────────────────────────────────────────────────────────────────────────────
function pfAccountCommand() {
    return new SlashCommandBuilder()
        .setName('pf-account')
        .setDescription('Show PlayFab account standings (history & notes).')
        .addStringOption(o =>
            o.setName('id')
                .setDescription('PlayFabId, SteamID64, or Steam profile URL')
                .setRequired(true)
        );
}

async function postAccount(inter, cfgMaybe) {
    const cfg = coalesceConfig(cfgMaybe);
    const id = inter.options.getString('id', true);
    try {
        await inter.deferReply({ ephemeral: true });
        const { playFabId, steam64, vanity } = await resolvePlayerFromInput(id, cfg);
        return renderAccountPanel(inter, { playFabId, steam64, vanity }, cfg);
    } catch (e) {
        return inter.editReply({ content: `❌ PlayFab error: ${e.message}` });
    }
}

function buildAccountEmbed(pfid, identity, history) {
    const bans = history.filter(h => h.type === 'ban');
    const mutes = history.filter(h => h.type === 'mute');
    const resets = history.filter(h => h.type === 'reset');
    const notes = history.filter(h => h.type === 'note');

    const emb = new EmbedBuilder()
        .setColor(0x0ea5e9)
        .setTitle('🧾 Account Standings')
        .setDescription(
            `**PlayFabId:** \`${pfid}\`${identity.steam64 ? `\n**Steam64:** \`${identity.steam64}\`` : ''}${identity.vanity ? `\n**Vanity:** \`${identity.vanity}\`` : ''}`
        )
        .addFields(
            { name: 'Bans', value: bans.length ? bans.map(b => `• ${b.duration || '0h'} — ${b.reason || 'No reason'} (${new Date(b.executedAt).toLocaleString()})`).slice(0, 5).join('\n') : 'None', inline: false },
            { name: 'Mutes', value: mutes.length ? mutes.map(m => `• until ${m.expiresAt || '?'} — ${m.reason || 'No reason'} (${new Date(m.executedAt).toLocaleString()})`).slice(0, 5).join('\n') : 'None', inline: false },
            { name: 'Resets', value: resets.length ? resets.map(r => `• ${new Date(r.executedAt).toLocaleString()}`).slice(0, 5).join('\n') : 'None', inline: false },
            { name: `Notes (${notes.length})`, value: notes.length ? notes.slice(-3).map(n => `• **${n.title || '(untitled)'}** — ${new Date(n.createdAt).toLocaleString()} by <@${n.createdBy}>`).join('\n') : 'None', inline: false },
        )
        .setFooter({ text: 'OUTBRK • PlayFab Tools' });
    return emb;
}

async function renderAccountPanel(inter, identity, cfg) {
    const history = Store.historyForPlayFabId(identity.playFabId);
    const emb = buildAccountEmbed(identity.playFabId, identity, history);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pfacct|addnote|${identity.playFabId}`).setLabel('Add Note').setStyle(ButtonStyle.Primary).setEmoji('📝'),
        new ButtonBuilder().setCustomId(`pfacct|refresh|${identity.playFabId}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
    );

    return inter.editReply({ embeds: [emb], components: [row] });
}

async function handleAccountButton(inter, cfgMaybe) {
    if (!inter.customId?.startsWith('pfacct|')) return;
    const cfg = coalesceConfig(cfgMaybe);
    const [, action, pfid] = inter.customId.split('|');

    if (action === 'addnote') {
        const modal = new ModalBuilder().setCustomId(`pfacct|note_modal|${pfid}`).setTitle('Add Account Note');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(45)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('body').setLabel('Note').setStyle(TextInputStyle.Paragraph).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('confirm').setLabel('Type YES to confirm').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)
            ),
        );
        return inter.showModal(modal);
    }

    if (action === 'refresh') {
        await inter.deferReply({ ephemeral: true });
        const history = Store.historyForPlayFabId(pfid);
        const emb = buildAccountEmbed(pfid, { playFabId: pfid }, history);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pfacct|addnote|${pfid}`).setLabel('Add Note').setStyle(ButtonStyle.Primary).setEmoji('📝'),
            new ButtonBuilder().setCustomId(`pfacct|refresh|${pfid}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
        );
        return inter.editReply({ embeds: [emb], components: [row] });
    }
}

async function handleAccountModal(inter, cfgMaybe) {
    if (!inter.customId?.startsWith('pfacct|note_modal|')) return;
    const cfg = coalesceConfig(cfgMaybe);
    const [, , pfid] = inter.customId.split('|');

    const title = inter.fields.getTextInputValue('title')?.trim();
    const body = inter.fields.getTextInputValue('body')?.trim();
    const conf = inter.fields.getTextInputValue('confirm')?.trim().toUpperCase();

    if (conf !== 'YES') return inter.reply({ ephemeral: true, content: '❌ 2FA failed (type YES).' });

    Store.addHistory({
        id: Store.newId(),
        type: 'note',
        playFabId: pfid,
        title,
        text: body,
        createdBy: inter.user.id,
        createdAt: new Date().toISOString()
    });

    // Re-render panel quickly
    const history = Store.historyForPlayFabId(pfid);
    const emb = buildAccountEmbed(pfid, { playFabId: pfid }, history);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pfacct|addnote|${pfid}`).setLabel('Add Note').setStyle(ButtonStyle.Primary).setEmoji('📝'),
        new ButtonBuilder().setCustomId(`pfacct|refresh|${pfid}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
    );
    return inter.reply({ ephemeral: true, embeds: [emb], components: [row] });
}

// ──────────────────────────────────────────────────────────────────────────────
module.exports = {
    // existing exports
    pfPanelCommand,
    postPanel,
    handleButton,
    handleModal,
    resolvePlayerFromInput,

    // new account panel exports
    pfAccountCommand,
    postAccount,
    handleAccountButton,
    handleAccountModal,
};
