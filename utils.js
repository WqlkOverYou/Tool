// utils.js
const {
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const { createTranscript } = require('discord-html-transcripts');

// ---------- UI helpers ----------
const makeInput = (id, label, style = 'SHORT', placeholder = '') =>
    new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style === 'PARAGRAPH' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(placeholder);

const claimBtn = () => new ButtonBuilder().setCustomId('claim').setLabel('Claim').setStyle(ButtonStyle.Success);
const assignBtn = () => new ButtonBuilder().setCustomId('assign').setLabel('Assign').setStyle(ButtonStyle.Primary);
const escalateBtn = () => new ButtonBuilder().setCustomId('escalate').setLabel('Escalate').setStyle(ButtonStyle.Secondary);
const manageBtn = () => new ButtonBuilder().setCustomId('manage_ticket').setLabel('Manage Ticket').setStyle(ButtonStyle.Danger);

const manageSelect = (customId = 'manage_select') =>
    new ActionRowBuilder().addComponents(
        require('discord.js').StringSelectMenuBuilder.from({
            custom_id: customId,
            placeholder: 'Select an action for this ticket...',
            options: [
                { label: 'Close Immediately', value: 'close_now', description: 'Close now with custom reason' },
                { label: 'Warn for Missing Info', value: 'warn_missing_info', description: 'DM opener: will close in 24h if no info' },
                { label: 'Warn for Inactivity', value: 'warn_inactivity', description: 'DM opener: will close in 24h if inactive' },
                { label: 'Close – Resolved', value: 'close_resolved', description: 'Close ticket as resolved (adds reason)' },
                { label: 'Close – Known Issue', value: 'close_known', description: 'Close as known issue (requires Trello link)' },
                { label: 'Close — Missing Info (Guide)', value: 'close_missing_info', description: 'Post message & close with transcript' },
            ],
            type: 3
        })
    );

// ---------- Links / roles ----------
const threadLink = (guildId, threadId) =>
    `https://discord.com/channels/${guildId}/${threadId}`;

function hasRole(member, config, which /* 'tester' | 'lead' */) {
    const isPrivate = config.qaNotifyGuildId && member?.guild?.id === config.qaNotifyGuildId;
    const roleId = isPrivate
        ? (which === 'lead' ? config.LeadQualityAssuranceRoleIdPrivate : config.qaTesterRoleIdPrivate)
        : (which === 'lead' ? config.LeadQualityAssuranceRoleId : config.qaTesterRoleId);
    return !!(roleId && member?.roles?.cache?.has(roleId));
}

// ---------- Public texts ----------
const MISSING_INFO_TEXT =
    `⚠️ **Missing Information**

We appreciate the time you took to file this report with us; however, in its current state, we can't properly investigate this issue for you. Please read over the **#bug reporting guide**, and include all the given information, including **player log files**, in a brand new ticket. This ticket will now be closed. If you require further assistance, please create a new ticket, following the guide & ensuring the log file is attached.

**Navigate to your Windows search bar and run the following command to view log files:**

\`%userprofile%\\appdata\\locallow\\Sublime\\OUTBRK\``;

const genericCloseMessage = (openerId, reason) =>
    `🔒 **Ticket Closed**

Hey <@${openerId}> 👋

We’re closing this ticket at this time.  
**Reason:** ${reason}

If anything changes or you have new information to share, please feel free to open a new ticket and we’ll jump back in to help.

See you in the chase! 🌪️  
OUTBRK Support Team`;

// ---------- Closing / transcript (safe order) ----------
async function closeWithTranscript(inter, channel, config, closeText) {
    if (!inter.deferred && !inter.replied) {
        try { await inter.deferReply({ ephemeral: true }); } catch { }
    }

    let buf = null;
    try {
        buf = await createTranscript(channel, {
            returnType: 'buffer',
            filename: `transcript-${channel.id}.html`,
            minify: true,
            theme: 'dark'
        });
    } catch (e) {
        console.error('[transcript] failed:', e);
    }

    try {
        const logCh = await inter.client.channels.fetch(config.logChannelId);
        const files = buf ? [{ attachment: buf, name: `transcript-${channel.id}.html` }] : [];
        await logCh.send({ content: `📁 Transcript of #${channel.name}`, files });
    } catch (e) {
        console.error('Transcript post failed:', e);
    }

    if (closeText) {
        try { await channel.send(closeText); } catch { }
    }
    try { await channel.setLocked(true, 'Closed by QA'); } catch { }
    try { await channel.setArchived(true, 'Closed by QA'); } catch { }

    try {
        if (inter.deferred && !inter.replied) {
            await inter.editReply({ content: '✅ Ticket closed successfully.', ephemeral: true });
        }
    } catch { }
}

async function closeMissingInfo(inter, channel, config) {
    try {
        await closeWithTranscript(inter, channel, config, MISSING_INFO_TEXT);
        try { qaStats.recordClose(channel.id); } catch { }
    } catch (e) {
        console.error('[closeMissingInfo] failed:', e);
        try {
            if (!inter.deferred && !inter.replied) {
                await inter.reply({ ephemeral: true, content: 'Ticket closed (missing info).' });
            }
        } catch { }
    }
}

// ---------- Claim button disabling (auto-claim visual) ----------
async function disableClaimButtonIfPresent(thread) {
    try {
        const msgs = await thread.messages.fetch({ limit: 25 });
        const botMsgs = msgs.filter(m => m.author.bot && m.components?.length);
        for (const m of botMsgs.values()) {
            const row = m.components[0];
            const claim = row.components.find(c => c.customId === 'claim' && !c.disabled);
            if (claim) {
                const rebuilt = row.components.map(c => {
                    const B = ButtonBuilder.from(c);
                    return c.customId === 'claim' ? B.setDisabled(true).setLabel('Claimed') : B;
                });
                await m.edit({ components: [new ActionRowBuilder().addComponents(rebuilt)] });
                break;
            }
        }
    } catch { }
}

// ---------- Remote control action row (posted in private QA) ----------
function remoteManageRow(threadId, guildId) {
    const mk = (id, label, style) =>
        new ButtonBuilder().setCustomId(`remote|${id}|${guildId}|${threadId}`).setLabel(label).setStyle(style);
    return new ActionRowBuilder().addComponents(
        mk('claim', 'Claim', ButtonStyle.Success),
        mk('assign', 'Assign', ButtonStyle.Primary),
        mk('manage', 'Manage Ticket', ButtonStyle.Danger),
    );
}

// ---------- Resolve the ticket opener from messages/members (robust) ----------
async function resolveOpenerId(thread, client) {
    try {
        const msgs = await thread.messages.fetch({ limit: 50 });
        const ordered = [...msgs.values()].reverse(); // oldest → newest
        for (const m of ordered) {
            const firstMention = m.mentions?.users?.first();
            if (firstMention && !firstMention.bot) return firstMention.id;    // e.g., "Hey <@id>"
            if (!m.author.bot) return m.author.id;                            // fallback
        }
    } catch { }
    try {
        const coll = await thread.members.fetch(); // Collection<ThreadMember>
        const any = coll.find(tm => tm.id !== client.user.id);
        return any?.id ?? null;
    } catch { }
    return null;
}

// ---------- QA stats (persisted) ----------
const DATA_PATH = path.join(__dirname, 'qaStats.json');
function loadJsonSafe() {
    try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
    catch { return { users: {} }; }
}
function saveJsonSafe(obj) {
    try { fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2), 'utf8'); }
    catch (e) { console.error('[qaStats] save failed:', e); }
}

const qaStats = {
    _data: new Map(),   // userId -> { handledSet:Set, active:Map(threadId->{guildId,assignedAt,firstResponseMs}), closedCount:number, responses:number[], messagesPublic:number }
    _dirty: false,
    _timer: null,

    _get(uid) {
        if (!this._data.has(uid)) {
            this._data.set(uid, {
                handledSet: new Set(),
                active: new Map(),
                closedCount: 0,
                responses: [],
                messagesPublic: 0
            });
        }
        return this._data.get(uid);
    },

    // ---------- persistence ----------
    load() {
        const raw = loadJsonSafe();
        for (const [uid, v] of Object.entries(raw.users || {})) {
            const entry = {
                handledSet: new Set(v.handled || []),
                active: new Map(Object.entries(v.active || {})), // { [threadId]: {guildId,assignedAt,firstResponseMs}}
                closedCount: v.closed || 0,
                responses: v.responses || [],
                messagesPublic: v.messagesPublic || 0
            };
            this._data.set(uid, entry);
        }
    },

    _scheduleSave() {
        this._dirty = true;
        if (this._timer) return;
        this._timer = setTimeout(() => this.saveNow().catch(() => { }), 1000);
    },

    async saveNow() {
        try {
            if (!this._dirty) return;
            const obj = { users: {} };
            for (const [uid, s] of this._data) {
                const activeObj = {};
                for (const [tid, val] of s.active) activeObj[tid] = val;
                obj.users[uid] = {
                    handled: [...s.handledSet],
                    active: activeObj,
                    closed: s.closedCount,
                    responses: s.responses,
                    messagesPublic: s.messagesPublic
                };
            }
            saveJsonSafe(obj);
            this._dirty = false;
            clearTimeout(this._timer); this._timer = null;
        } catch (e) {
            console.error('[qaStats] saveNow error:', e);
        }
    },

    // ---------- counters ----------
    recordAssign(uid, guildId, threadId) {
        const s = this._get(uid);
        s.handledSet.add(threadId);
        if (!s.active.has(threadId)) {
            s.active.set(threadId, { guildId, assignedAt: Date.now(), firstResponseMs: null });
        }
        this._scheduleSave();
    },

    recordClaim(uid, threadId) {
        const s = this._get(uid);
        s.handledSet.add(threadId);
        const slot = s.active.get(threadId);
        if (slot && slot.firstResponseMs == null) {
            slot.firstResponseMs = Date.now() - slot.assignedAt;
            s.responses.push(slot.firstResponseMs);
        }
        this._scheduleSave();
    },

    recordClose(threadId) {
        for (const [, s] of this._data) {
            if (s.active.has(threadId)) {
                s.active.delete(threadId);
                s.closedCount++;
            }
        }
        this._scheduleSave();
    },

    recordMessage(uid /*, guildId */) {
        const s = this._get(uid);
        s.messagesPublic++;
        this._scheduleSave();
    },

    summary(uid) {
        const s = this._get(uid);
        const activeList = [...s.active].map(([threadId, v]) => ({ threadId, guildId: v.guildId }));
        const avg = s.responses.length
            ? Math.round(s.responses.reduce((a, b) => a + b, 0) / s.responses.length)
            : 0;
        const sorted = [...s.responses].sort((a, b) => a - b);
        const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
        return {
            handled: s.handledSet.size,
            closed: s.closedCount,
            active: activeList,
            avgResponseMs: avg,
            medianResponseMs: med,
            messagesPublic: s.messagesPublic
        };
    }
};

// load persisted data immediately
qaStats.load();

module.exports = {
    makeInput,
    claimBtn, assignBtn, escalateBtn, manageBtn,
    manageSelect,
    closeWithTranscript,
    closeMissingInfo,
    disableClaimButtonIfPresent,
    remoteManageRow,
    resolveOpenerId,
    threadLink,
    hasRole,
    qaStats,
    MISSING_INFO_TEXT,
    genericCloseMessage
};
