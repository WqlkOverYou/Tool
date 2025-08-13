// ticketHandlers.js
const {
    ModalBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    EmbedBuilder,
    ChannelType,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const {
    makeInput,
    claimBtn, assignBtn, escalateBtn, manageBtn,
    manageSelect,
    closeWithTranscript,
    disableClaimButtonIfPresent,
    remoteManageRow,
    resolveOpenerId,
    threadLink,
    hasRole,
    qaStats
} = require('./utils');

// small helper: safe read of modal fields (prevents crashes if a field isn't present)
const safeGet = (inter, id) => {
    try { return inter.fields.getTextInputValue(id) || ''; } catch { return ''; }
};

// ──────────────────────────────────────────────────────────────────────────────
// 📑 Handle Selects (ticket_type, assign_ticket, manage_select, remote_*)
// ──────────────────────────────────────────────────────────────────────────────
async function handleSelect(inter, client, config) {
    // Open modal for ticket creation
    if (inter.customId === 'ticket_type') {
        const type = inter.values[0];
        const modal = new ModalBuilder()
            .setCustomId(`mod|${type}`)
            .setTitle(`${type} Form`);

        if (type === 'Player Report') {
            modal.addComponents(
                new ActionRowBuilder().addComponents(makeInput('displayName', 'Display name of reported player?', 'SHORT', 'e.g. StormChaser42')),
                new ActionRowBuilder().addComponents(makeInput('where', 'Where did this incident occur?', 'SHORT', 'e.g. Lobby #3')),
                new ActionRowBuilder().addComponents(makeInput('when', 'When did this occur?', 'SHORT', 'e.g. 2025-07-26 14:30 UTC')),
                new ActionRowBuilder().addComponents(makeInput('guidelines', 'Which guidelines were broken?', 'PARAGRAPH', 'e.g. Harassment')),
                new ActionRowBuilder().addComponents(makeInput('details', 'Describe the incident in depth', 'PARAGRAPH', 'e.g. Hate speech…'))
            );
        } else if (type === 'Punishment Appeal') {
            // 64-bit SteamID placeholder
            modal.addComponents(
                new ActionRowBuilder().addComponents(makeInput('steamId', 'Your Steam ID?', 'SHORT', 'e.g. 76561199224604471')),
                new ActionRowBuilder().addComponents(makeInput('punishWhen', 'When was punishment issued?', 'SHORT', 'e.g. 2025-07-20')),
                new ActionRowBuilder().addComponents(makeInput('remaining', 'Time left on punishment?', 'SHORT', 'e.g. 2 days')),
                new ActionRowBuilder().addComponents(makeInput('whyPunished', 'Why were you punished?', 'PARAGRAPH', 'e.g. Chat spam')),
                new ActionRowBuilder().addComponents(makeInput('whyUnban', 'Why should you be unpunished?', 'PARAGRAPH', 'e.g. Mistake'))
            );
        } else if (type === 'Other') {
            modal.addComponents(new ActionRowBuilder().addComponents(
                makeInput('other', 'Describe your issue', 'PARAGRAPH', 'e.g. Account help')
            ));
        } else if (type === 'Bug Report') {
            modal.addComponents(
                new ActionRowBuilder().addComponents(makeInput('shortTitle', 'Short Title', 'SHORT', 'e.g. Game Crash')),
                new ActionRowBuilder().addComponents(makeInput('overview', 'Incident Overview', 'PARAGRAPH', 'e.g. While driving my game crashed...')),
                new ActionRowBuilder().addComponents(makeInput('steps', 'Steps To Reproduce bug', 'PARAGRAPH', 'e.g. Drive DOM3 into a wall...')),
                new ActionRowBuilder().addComponents(makeInput('expected', 'Expected Behavior', 'PARAGRAPH', 'e.g. I believe I shouldn\'t have crashed...')),
                new ActionRowBuilder().addComponents(makeInput('readGuide', 'Did you read bug report guide?', 'SHORT', 'Yes/No'))
            );
        }

        return inter.showModal(modal);
    }

    // Assign/Unassign (local)
    if (inter.customId === 'assign_ticket') {
        await inter.deferUpdate();
        const assigneeId = inter.values[0];
        const thread = inter.channel;

        if (thread.members.cache.has(assigneeId)) {
            await thread.send(`🗑 Unassigned <@${assigneeId}> by <@${inter.user.id}>`);
            await thread.members.remove(assigneeId);
            return inter.followUp({ ephemeral: true, content: `Unassigned <@${assigneeId}>!` });
        } else {
            await thread.members.fetch();
            await thread.members.add(assigneeId);

            qaStats.recordAssign(assigneeId, inter.guild.id, thread.id);
            await disableClaimButtonIfPresent(thread);

            const emb = new EmbedBuilder()
                .setDescription(
                    `<@${assigneeId}> has now been assigned to this case, ` +
                    `please allow an additional 24 hours for them to begin processing this ticket\n\n` +
                    `Thank you for your patience,\nOUTBRK Support Team`
                )
                .setColor(0x5865F2)
                .setTimestamp();

            await thread.send({ embeds: [emb] });

            const assignee = await inter.guild.members.fetch(assigneeId);
            try { await assignee.send(`You have been assigned to ticket: ${threadLink(inter.guild.id, thread.id)}`); } catch { }

            return inter.followUp({ ephemeral: true, content: `Assigned <@${assigneeId}>!` });
        }
    }

    // Manage ticket (LOCAL) — IMPORTANT: don't defer if showing a modal
    if (inter.customId === 'manage_select') {
        const action = inter.values[0];
        const thread = inter.channel;
        const openerId = await resolveOpenerId(thread, inter.client);

        // Actions that open a modal (no defer)
        if (action === 'close_now') {
            const modal = new ModalBuilder()
                .setCustomId('mod|close_now')
                .setTitle('Close Ticket - Reason')
                .addComponents(
                    new ActionRowBuilder().addComponents(makeInput('closeReason', 'Reason for closing', 'PARAGRAPH', 'Enter your reason here…'))
                );
            return inter.showModal(modal);
        }
        if (action === 'close_resolved') {
            const modal = new ModalBuilder()
                .setCustomId('mod|close_resolved')
                .setTitle('Close – Resolved')
                .addComponents(
                    new ActionRowBuilder().addComponents(makeInput('resolvedReason', 'Brief resolution note', 'PARAGRAPH', 'Describe how this was resolved…'))
                );
            return inter.showModal(modal);
        }
        if (action === 'close_known') {
            const modal = new ModalBuilder()
                .setCustomId('mod|close_known')
                .setTitle('Close – Known Issue')
                .addComponents(
                    new ActionRowBuilder().addComponents(makeInput('knownReason', 'Short note', 'PARAGRAPH', 'Why this maps to a known issue…')),
                    new ActionRowBuilder().addComponents(makeInput('trello', 'Trello ticket link', 'SHORT', 'https://trello.com/c/…'))
                );
            return inter.showModal(modal);
        }

        // Actions that do not open a modal → update or act
        if (action === 'warn_missing_info') {
            if (openerId) {
                try {
                    const user = await inter.client.users.fetch(openerId);
                    await user.send(
                        `📬 Hi <@${openerId}>, your bug report will be **closed in 24 hours** unless you provide the required information from the guide.\n` +
                        `Thread: ${threadLink(inter.guild.id, thread.id)}`
                    );
                } catch { }
            }
            const warn = new EmbedBuilder()
                .setTitle('⚠️ Missing Information')
                .setDescription(`This thread will be **closed in 24 hours** unless the required information from the bug report guide is provided.`)
                .setColor(0xFFA500).setTimestamp();
            await thread.send({ embeds: [warn] });

            return inter.update({
                content: '✅ Reporter warned about missing info.',
                components: [manageSelect('manage_select')]
            });
        }

        if (action === 'warn_inactivity') {
            if (openerId) {
                try {
                    const user = await inter.client.users.fetch(openerId);
                    await user.send(
                        `📬 Hi <@${openerId}>, this thread will be **closed in 24 hours** due to inactivity unless you respond.\n` +
                        `Thread: ${threadLink(inter.guild.id, thread.id)}`
                    );
                } catch { }
            }
            const warn = new EmbedBuilder()
                .setTitle('⏳ Inactivity Warning')
                .setDescription(`This thread will be **closed in 24 hours** due to inactivity if there are no further responses.`)
                .setColor(0xFFA500).setTimestamp();
            await thread.send({ embeds: [warn] });

            return inter.update({
                content: '✅ Inactivity warning posted.',
                components: [manageSelect('manage_select')]
            });
        }

        if (action === 'close_missing_info') {
            // Post standard message then close with transcript
            const msg =
                '⚠️ **Missing Information**\n\n' +
                'We appreciate the time you took to file this report with us; however, in its current state, we can’t properly investigate this issue for you. ' +
                'Please read over the **bug reporting guide**, and include all the given information, including player log files, in a brand new ticket. ' +
                'This ticket will now be closed. If you require further assistance, please create a new ticket, following the guide & ensuring the log file is attached.\n' +
                '**\n\nNavigate to your Windows search bar and run the following command to view log files.\n\n' +
                '%userprofile%\\appdata\\locallow\\Sublime\\OUTBRK\n**';

            await closeWithTranscript(inter, thread, config, msg);
            qaStats.recordClose(thread.id);
            return; // closeWithTranscript handles reply
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
async function handleModal(inter, client, config) {
    const [prefix, type, gId, tId] = inter.customId.split('|');

    // ---------- Remote close modals ----------
    if (prefix === 'remote_modal') {
        const target = await client.channels.fetch(tId).catch(() => null);
        if (!target) return inter.reply({ ephemeral: true, content: 'Thread not found.' });

        if (type === 'close_now') {
            const reason = safeGet(inter, 'closeReason');
            await closeWithTranscript(inter, target, config, `🔒 Ticket closed by <@${inter.user.id}>: **${reason}**`);
            qaStats.recordClose(target.id);
            return;
        }
        if (type === 'close_resolved') {
            const note = safeGet(inter, 'resolvedReason');
            await closeWithTranscript(inter, target, config, `✅ Resolved by <@${inter.user.id}> — ${note}`);
            qaStats.recordClose(target.id);
            return;
        }
        if (type === 'close_known') {
            const trello = safeGet(inter, 'trello');
            const openerId = await resolveOpenerId(target, client);
            const wave = '👋'; // emoji ok to inline
            const tornado = '🌪️';
            const text =
                `Hey <@${openerId}> ${wave}\n\n` +
                'We appreciate the time you took to file this report with us; however, it is already a known issue on our Trello board. ' +
                'This ticket will be closed, but don’t hesitate to open a new thread if further issues arise, and we will be happy to help. ' +
                'You can track all progress regarding this issue via the issue tracker link below.\n\n' +
                `Issue Tracker: ${trello}\n\n` +
                `See you in the chase! ${tornado}\n` +
                'OUTBRK Support Team';

            await closeWithTranscript(inter, target, config, text);
            qaStats.recordClose(target.id);
            return;
        }
    }

    // ---------- Escalate ----------
    if (type === 'escalate') {
        const reason = safeGet(inter, 'escalationReason'),
            thread = inter.channel,
            url = threadLink(thread.guild.id, thread.id);

        await inter.deferReply({ ephemeral: true });
        await inter.guild.members.fetch();
        const leadRole = inter.guild.roles.cache.get(config.LeadQualityAssuranceRoleId);
        for (const lead of leadRole?.members?.values?.() ?? []) {
            try {
                await lead.send(
                    `🚨 **Ticket Escalated** 🚨\n` +
                    `**By:** <@${inter.user.id}>\n` +
                    `**Thread:** ${url}\n\n` +
                    `**Reason:**\n${reason}`
                );
            } catch (err) { console.error('DM fail', err); }
        }
        return inter.editReply({ content: '🚨 Ticket escalated to Lead QA.' });
    }

    // ---------- BUG REPORT ----------
    if (type === 'Bug Report') {
        const title = safeGet(inter, 'shortTitle'),
            overview = safeGet(inter, 'overview'),
            steps = safeGet(inter, 'steps'),
            expected = safeGet(inter, 'expected'),
            readGuide = safeGet(inter, 'readGuide');

        let forumCh;
        if (config.bugForumChannelId) {
            forumCh = await client.channels.fetch(config.bugForumChannelId);
        } else {
            forumCh = inter.guild.channels.cache.find(c =>
                c.type === ChannelType.GuildForum &&
                c.name.toLowerCase().includes('bug-reports')
            );
        }
        if (!forumCh) {
            return inter.reply({ content: '❌ Cannot find your bug-reports forum channel!', ephemeral: true });
        }

        const welcomeEmbed = new EmbedBuilder()
            .setDescription(
                `We appreciate you taking the time to open a bug report, and a member of our team will be here to assist you within 24 hours! Please ensure you have fully read the bug report guide and attach the following information to this thread.\n\n` +
                `1. Please provide supplemental evidence to this bug report in the form of screenshots or videos if applicable.\n` +
                `2. Attach your player.log or player.prev log file as outlined in the #support-guide. You can find this by copying into your Windows search bar: **%userprofile%\\appdata\\locallow\\Sublime\\OUTBRK**\n\n` +
                `**Failure to provide the information within an hour of the bug report being opened will result in it being closed as our team cannot assist without this information. Thank you for understanding!**`
            );

        const summaryEmbed = new EmbedBuilder()
            .setTitle(`🐛 ${title}`)
            .addFields(
                { name: 'Incident Overview', value: overview || ' ' },
                { name: 'Steps To Reproduce', value: steps || ' ' },
                { name: 'Expected Behavior', value: expected || ' ' },
                { name: 'Read Guide?', value: readGuide || ' ' }
            )
            .setFooter({ text: `Reporter: ${inter.user.tag}` })
            .setTimestamp();

        const thread = await forumCh.threads.create({
            name: title || 'Bug report',
            autoArchiveDuration: 1440,
            reason: 'New bug report',
            message: {
                content: `Hey <@${inter.user.id}> 👋`,
                embeds: [welcomeEmbed, summaryEmbed],
                components: [new ActionRowBuilder().addComponents(claimBtn(), assignBtn(), escalateBtn(), manageBtn())]
            }
        });

        if (config.qaNotifyChannelId) {
            try {
                const qaChannel = await client.channels.fetch(config.qaNotifyChannelId);
                await qaChannel.send({
                    content: `🐛 New bug report by <@${inter.user.id}>: ${threadLink(thread.guild.id, thread.id)}`,
                    components: [remoteManageRow(thread.id, thread.guild.id)]
                });
            } catch (e) { console.error('QA notify failed:', e); }
        }

        return inter.reply({ content: `🪲 Bug filed: ${thread}`, ephemeral: true });
    }

    // ---------- Local close modals ----------
    if (type === 'close_now') {
        const reason = safeGet(inter, 'closeReason');
        await closeWithTranscript(inter, inter.channel, config, `🔒 Ticket closed by <@${inter.user.id}>: **${reason}**`);
        qaStats.recordClose(inter.channel.id);
        return;
    }
    if (type === 'close_resolved') {
        const note = safeGet(inter, 'resolvedReason');
        await closeWithTranscript(inter, inter.channel, config, `✅ Resolved by <@${inter.user.id}> — ${note}`);
        qaStats.recordClose(inter.channel.id);
        return;
    }
    if (type === 'close_known') {
        const trello = safeGet(inter, 'trello');
        const openerId = await resolveOpenerId(inter.channel, client);
        const wave = '👋';
        const tornado = '🌪️';
        const text =
            `Hey <@${openerId}> ${wave}\n\n` +
            'We appreciate the time you took to file this report with us; however, it is already a known issue on our Trello board. ' +
            'This ticket will be closed, but don’t hesitate to open a new thread if further issues arise, and we will be happy to help. ' +
            'You can track all progress regarding this issue via the issue tracker link below.\n\n' +
            `Issue Tracker: ${trello}\n\n` +
            `See you in the chase! ${tornado}\n` +
            'OUTBRK Support Team';

        await closeWithTranscript(inter, inter.channel, config, text);
        qaStats.recordClose(inter.channel.id);
        return;
    }

    // ---------- Tickets (player/appeal/other) ----------
    const supportCh = await client.channels.fetch(config.supportChannelId);
    const tPrefix = type === 'Player Report' ? 'report'
        : type === 'Punishment Appeal' ? 'appeal'
            : 'other';

    const thread = await supportCh.threads.create({
        name: `ticket-${tPrefix}-${inter.user.username}`,
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        invitable: false
    });
    await thread.members.add(inter.user.id);

    if (type === 'Player Report') {
        const welcomeEmbed = new EmbedBuilder()
            .setDescription(
                `We appreciate you taking the time to open a player report, and a member of our team will be here to assist you within 24 hours! Please ensure you have fully read the player report guide and attach the following information to this thread, so we can investigate any misconduct properly.\n\n` +
                `1. Please attach uncropped video and screenshot evidence to support your case\n` +
                `2. Attach your player.log or player.prev log file as outlined in the #support-guide. You can find this by copying into your Windows search bar: **%userprofile%\\appdata\\locallow\\Sublime\\OUTBRK**\n\n` +
                `**Failure to provide the information within an hour of the player report being opened will result in it being closed as our team cannot assist without this information. Thank you for understanding!**`
            );
        await thread.send({ content: `Hey <@${inter.user.id}> 👋`, embeds: [welcomeEmbed] });
    }

    if (config.qaNotifyChannelId) {
        try {
            const qaChannel = await client.channels.fetch(config.qaNotifyChannelId);
            await qaChannel.send({
                content: `🎟️ New **${type}** by <@${inter.user.id}>: ${threadLink(thread.guild.id, thread.id)}`,
                components: [remoteManageRow(thread.id, thread.guild.id)]
            });
        } catch (e) { console.error('QA notify failed:', e); }
    }

    const fields = [];
    if (type === 'Player Report') {
        fields.push(
            { name: 'Player', value: safeGet(inter, 'displayName'), inline: true },
            { name: 'Where?', value: safeGet(inter, 'where'), inline: true },
            { name: 'When?', value: safeGet(inter, 'when'), inline: true },
            { name: 'Guidelines', value: safeGet(inter, 'guidelines'), inline: false },
            { name: 'Details', value: safeGet(inter, 'details'), inline: false }
        );
    } else if (type === 'Punishment Appeal') {
        fields.push(
            { name: 'Steam ID', value: safeGet(inter, 'steamId'), inline: true },
            { name: 'When?', value: safeGet(inter, 'punishWhen'), inline: true },
            { name: 'Remaining', value: safeGet(inter, 'remaining'), inline: true },
            { name: 'Why Punished', value: safeGet(inter, 'whyPunished'), inline: false },
            { name: 'Why Unpunish', value: safeGet(inter, 'whyUnban'), inline: false }
        );
    } else {
        fields.push({ name: 'Issue', value: safeGet(inter, 'other'), inline: false });
    }

    const color = tPrefix === 'report' ? 0xED4245
        : tPrefix === 'appeal' ? 0xFEE75C
            : 0x57F287;

    const summary = new EmbedBuilder()
        .setTitle(`📋 ${type}`)
        .setColor(color)
        .setDescription(fields.map(f => `**${f.name}**\n\`\`\`${f.value || ' '}\`\`\``).join('\n\n'))
        .setFooter({ text: inter.user.tag })
        .setTimestamp();

    await thread.send({
        embeds: [summary],
        components: [new ActionRowBuilder().addComponents(claimBtn(), assignBtn(), escalateBtn(), manageBtn())]
    });

    return inter.reply({ content: `🎟 Ticket created: ${thread}`, ephemeral: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// 🔘 Buttons (local guild) & QA panel button
// ──────────────────────────────────────────────────────────────────────────────
async function handleButton(inter, client, config) {
    const { customId, member, channel } = inter;

    if (customId === 'claim') {
        if (!hasRole(member, config, 'tester') && !hasRole(member, config, 'lead')) {
            return inter.reply({ content: '❌ Not authorized.', ephemeral: true });
        }
        const updated = inter.message.components[0].components.map(b =>
            b.customId === 'claim'
                ? ButtonBuilder.from(b).setDisabled(true).setLabel('Claimed')
                : b
        );
        qaStats.recordClaim(member.id, channel.id);
        await inter.update({ components: [new ActionRowBuilder().addComponents(updated)] });
        return channel.send(`🔔 Ticket claimed by <@${member.id}>`);
    }

    if (customId === 'assign') {
        if (!hasRole(member, config, 'lead')) {
            return inter.reply({ content: '❌ Only Lead QA may assign.', ephemeral: true });
        }
        await inter.guild.members.fetch();
        const roleId = config.qaTesterRoleId;
        const qaRole = inter.guild.roles.cache.get(roleId);
        const options = qaRole.members.map(m => ({
            label: m.user.username,
            value: m.id,
            description: m.user.tag
        })).slice(0, 25); // safety cap
        if (!options.length) return inter.reply({ ephemeral: true, content: 'No testers found for assignment.' });

        const menu = new StringSelectMenuBuilder()
            .setCustomId('assign_ticket')
            .setPlaceholder('Assign to a QA tester…')
            .addOptions(options);
        return inter.reply({
            ephemeral: true,
            content: 'Select a QA tester to assign this ticket:',
            components: [new ActionRowBuilder().addComponents(menu)]
        });
    }

    if (customId === 'escalate') {
        if (!hasRole(member, config, 'tester')) {
            return inter.reply({ content: '❌ Not authorized.', ephemeral: true });
        }
        const modal = new ModalBuilder()
            .setCustomId('mod|escalate')
            .setTitle('Escalate Ticket')
            .addComponents(new ActionRowBuilder().addComponents(
                makeInput('escalationReason', 'Reason for escalation', 'PARAGRAPH', 'Why are you escalating?')
            ));
        return inter.showModal(modal);
    }

    if (customId === 'manage_ticket') {
        // testers can manage per your latest rules; if you want only lead, swap back
        if (!hasRole(member, config, 'tester') && !hasRole(member, config, 'lead')) {
            return inter.reply({ content: '❌ Not authorized.', ephemeral: true });
        }
        return inter.reply({
            ephemeral: true,
            content: 'Please select how you’d like to manage this ticket:',
            components: [manageSelect('manage_select')]
        });
    }

    // QA stats panel button
    if (customId === 'qa|mystats') {
        const { qaStats, threadLink } = require('./utils');
        const s = qaStats.summary(inter.user.id);
        const lines = [];
        lines.push(`**Handled (assigned/claimed):** ${s.handled}`);
        lines.push(`**Closed (credited):** ${s.closed}`);
        lines.push(`**Avg first response:** ${s.avgResponseMs ? `${Math.round(s.avgResponseMs / 1000)}s` : '—'}`);
        if (s.active.length) {
            const list = s.active.slice(0, 10).map(a => `• ${threadLink(a.guildId, a.threadId)}`).join('\n');
            lines.push(`**Active (${s.active.length}):**\n${list}`);
        } else {
            lines.push('**Active:** 0');
        }

        const emb = new EmbedBuilder()
            .setTitle(`QA Stats — ${inter.user.tag}`)
            .setDescription(lines.join('\n'))
            .setColor(0x2b2d31)
            .setTimestamp();

        return inter.reply({ ephemeral: true, embeds: [emb] });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// 🌐 Remote mgmt from private QA server
// ──────────────────────────────────────────────────────────────────────────────
async function handleRemoteButton(inter, client, config) {
    const parts = inter.customId.split('|'); // ['remote','action','guildId','threadId']
    const action = parts[1], guildId = parts[2], threadId = parts[3];
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) return inter.reply({ ephemeral: true, content: 'Thread not found.' });

    if (action === 'claim') {
        if (!hasRole(inter.member, config, 'tester') && !hasRole(inter.member, config, 'lead'))
            return inter.reply({ content: '❌ Not authorized.', ephemeral: true });

        qaStats.recordClaim(inter.user.id, thread.id);
        await disableClaimButtonIfPresent(thread);
        await thread.send(`🔔 Ticket claimed by <@${inter.user.id}> (remote)`);
        return inter.reply({ ephemeral: true, content: 'Claimed.' });
    }

    if (action === 'assign') {
        if (!hasRole(inter.member, config, 'lead') && !hasRole(inter.member, config, 'tester')) // allow testers too if desired
            return inter.reply({ content: '❌ Not authorized.', ephemeral: true });

        const roleId = config.qaTesterRoleIdPrivate;
        const qaRole = inter.guild.roles.cache.get(roleId);
        let options = qaRole?.members?.map(m => ({
            label: m.user.username,
            value: `${guildId}:${threadId}:${m.id}`,
            description: m.user.tag
        })) ?? [];
        options = options.slice(0, 25); // Discord limit
        if (!options.length) return inter.reply({ ephemeral: true, content: 'No testers found to assign (private server role empty).' });

        const menu = new StringSelectMenuBuilder()
            .setCustomId('remote_assign_select')
            .setPlaceholder('Assign to a QA tester…')
            .addOptions(options);

        return inter.reply({ ephemeral: true, components: [new ActionRowBuilder().addComponents(menu)] });
    }

    if (action === 'manage') {
        if (!hasRole(inter.member, config, 'tester') && !hasRole(inter.member, config, 'lead'))
            return inter.reply({ content: '❌ Not authorized.', ephemeral: true });

        // include target ids in customId so we can act without proxy/defer loops
        const row = manageSelect(`remote_manage_select|${guildId}|${threadId}`);
        return inter.reply({
            ephemeral: true,
            content: `Manage: ${threadLink(guildId, threadId)}`,
            components: [row]
        });
    }
}

async function handleRemoteSelect(inter, client, config) {
    // Remote manage options (no defers; act directly)
    if (inter.customId.startsWith('remote_manage_select')) {
        const [, gId, tId] = inter.customId.split('|');
        const action = inter.values[0];
        const thread = await client.channels.fetch(tId).catch(() => null);
        if (!thread) return inter.reply({ ephemeral: true, content: 'Thread not found.' });

        const openerId = await resolveOpenerId(thread, client);

        // Warns (execute immediately)
        if (action === 'warn_missing_info') {
            if (openerId) {
                try {
                    const user = await client.users.fetch(openerId);
                    await user.send(
                        `📬 Hi <@${openerId}>, your bug report will be **closed in 24 hours** unless you provide the required information from the guide.\n` +
                        `Thread: ${threadLink(gId, tId)}`
                    );
                } catch { }
            }
            const warn = new EmbedBuilder()
                .setTitle('⚠️ Missing Information')
                .setDescription(`This thread will be **closed in 24 hours** unless the required information from the bug report guide is provided.`)
                .setColor(0xFFA500).setTimestamp();
            await thread.send({ embeds: [warn] });
            return inter.update({ content: '✅ Reporter warned about missing info.', components: inter.message.components });
        }

        if (action === 'warn_inactivity') {
            if (openerId) {
                try {
                    const user = await client.users.fetch(openerId);
                    await user.send(
                        `📬 Hi <@${openerId}>, this thread will be **closed in 24 hours** due to inactivity unless you respond.\n` +
                        `Thread: ${threadLink(gId, tId)}`
                    );
                } catch { }
            }
            const warn = new EmbedBuilder()
                .setTitle('⏳ Inactivity Warning')
                .setDescription(`This thread will be **closed in 24 hours** due to inactivity if there are no further responses.`)
                .setColor(0xFFA500).setTimestamp();
            await thread.send({ embeds: [warn] });
            return inter.update({ content: '✅ Inactivity warning posted.', components: inter.message.components });
        }

        if (action === 'close_missing_info') {
            const msg =
                '⚠️ **Missing Information**\n\n' +
                'We appreciate the time you took to file this report with us; however, in its current state, we can’t properly investigate this issue for you. ' +
                'Please read over the **bug reporting guide**, and include all the given information, including player log files, in a brand new ticket. ' +
                'This ticket will now be closed. If you require further assistance, please create a new ticket, following the guide & ensuring the log file is attached.\n' +
                '**\n\nNavigate to your Windows search bar and run the following command to view log files.\n\n' +
                '%userprofile%\\appdata\\locallow\\Sublime\\OUTBRK\n**';

            await closeWithTranscript(inter, thread, config, msg);
            qaStats.recordClose(thread.id);
            return; // reply handled by closeWithTranscript
        }

        // Closing actions → open modal on PRIVATE QA message, but target is remote thread
        if (action === 'close_now') {
            const modal = new ModalBuilder()
                .setCustomId(`remote_modal|close_now|${gId}|${tId}`)
                .setTitle('Close Ticket - Reason')
                .addComponents(
                    new ActionRowBuilder().addComponents(makeInput('closeReason', 'Reason for closing', 'PARAGRAPH', 'Enter your reason here…'))
                );
            return inter.showModal(modal);
        }
        if (action === 'close_resolved') {
            const modal = new ModalBuilder()
                .setCustomId(`remote_modal|close_resolved|${gId}|${tId}`)
                .setTitle('Close – Resolved')
                .addComponents(
                    new ActionRowBuilder().addComponents(makeInput('resolvedReason', 'Brief resolution note', 'PARAGRAPH', 'Describe how this was resolved…'))
                );
            return inter.showModal(modal);
        }
        if (action === 'close_known') {
            const modal = new ModalBuilder()
                .setCustomId(`remote_modal|close_known|${gId}|${tId}`)
                .setTitle('Close – Known Issue')
                .addComponents(
                    new ActionRowBuilder().addComponents(makeInput('knownReason', 'Short note', 'PARAGRAPH', 'Why this maps to a known issue…')),
                    new ActionRowBuilder().addComponents(makeInput('trello', 'Trello ticket link', 'SHORT', 'https://trello.com/c/…'))
                );
            return inter.showModal(modal);
        }
    }

    // Remote assign choice
    if (inter.customId === 'remote_assign_select') {
        await inter.deferUpdate();
        const [guildId, threadId, userId] = inter.values[0].split(':');
        const thread = await client.channels.fetch(threadId);

        await thread.members.fetch();
        await thread.members.add(userId);

        qaStats.recordAssign(userId, guildId, threadId);
        await disableClaimButtonIfPresent(thread);

        const emb = new EmbedBuilder()
            .setDescription(
                `<@${userId}> has now been assigned to this case, ` +
                `please allow an additional 24 hours for them to begin processing this ticket\n\n` +
                `Thank you for your patience,\nOUTBRK Support Team`
            )
            .setColor(0x5865F2)
            .setTimestamp();

        await thread.send({ embeds: [emb] });

        try {
            const u = await inter.guild.members.fetch(userId);
            await u.send(`You have been assigned to ticket: ${threadLink(guildId, threadId)}`);
        } catch { }

        return inter.followUp({ ephemeral: true, content: `Assigned <@${userId}>.` });
    }
}

module.exports = {
    handleSelect,
    handleModal,
    handleButton,
    handleRemoteButton,
    handleRemoteSelect
};
