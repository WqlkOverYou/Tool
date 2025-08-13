// commands.js
const {
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const { qaStats, hasRole, threadLink } = require('./utils');

// Register slash commands
module.exports = async function registerCommands(client, config) {
    const cmds = [
        new SlashCommandBuilder()
            .setName('setup-support')
            .setDescription('Post the OUTBRK Support Hub'),

        new SlashCommandBuilder()
            .setName('ban')
            .setDescription('Ban a member')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason')),

        new SlashCommandBuilder()
            .setName('kick')
            .setDescription('Kick a member')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason')),

        new SlashCommandBuilder()
            .setName('mute')
            .setDescription('Mute a member')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
            .addIntegerOption(o => o.setName('duration').setDescription('Minutes'))
            .addStringOption(o => o.setName('reason').setDescription('Reason')),

        new SlashCommandBuilder()
            .setName('setup-bugs')
            .setDescription('Create the 🐛 bug-reports forum channel'),

        new SlashCommandBuilder()
            .setName('report-bug')
            .setDescription('Open a modal to report a bug'),

        // QA Stats quick view (ephemeral)
        new SlashCommandBuilder()
            .setName('qa-stats')
            .setDescription('Show QA performance stats (ephemeral)')
            .addUserOption(o => o.setName('user').setDescription('View another user (Lead QA only)')),

        // QA Stats panel (post a panel into the channel)
        new SlashCommandBuilder()
            .setName('qa-stats-panel')
            .setDescription('Post a QA stats panel into this channel'),

        // PlayFab admin panel (OnlyBOTAdmin is enforced at runtime)
        new SlashCommandBuilder()
            .setName('pf-panel')
            .setDescription('Open the PlayFab admin panel (OnlyBOTAdmin)')
    ].map(c => c.toJSON());

    await new REST({ version: '10' })
        .setToken(config.token)
        .put(
            Routes.applicationGuildCommands(config.clientId, config.guildId),
            { body: cmds }
        );

    console.log('✅ Slash commands registered');
};

// Moderation + qa-stats handlers
module.exports.handleSlash = async function handleSlash(inter, client, config) {
    const { commandName, guild, member, options } = inter;

    // admin guard for setup-*
    if (member.id !== config.OnlyBOTAdmin && commandName.startsWith('setup-')) {
        return inter.reply({ content: '❌ Not authorized.', ephemeral: true });
    }

    switch (commandName) {
        case 'ban':
            await guild.members.ban(options.getUser('user').id, { reason: options.getString('reason') || 'No reason' });
            return inter.reply(`🔨 Banned ${options.getUser('user').tag}`);

        case 'kick':
            await guild.members.kick(options.getUser('user').id, options.getString('reason') || 'No reason');
            return inter.reply(`👢 Kicked ${options.getUser('user').tag}`);

        case 'mute': {
            const user = options.getUser('user'),
                dur = options.getInteger('duration'),
                reason = options.getString('reason') || 'No reason',
                tgt = await guild.members.fetch(user.id);
            await tgt.roles.add(config.mutedRoleId, reason);
            if (dur) setTimeout(() => tgt.roles.remove(config.mutedRoleId), dur * 60000);
            return inter.reply(`🔇 Muted ${user.tag}${dur ? ` for ${dur}m` : ''}`);
        }

        case 'setup-bugs': {
            const {
                ChannelType,
                PermissionsBitField
            } = require('discord.js');

            const forum = await guild.channels.create({
                name: '🐛 bug-reports',
                type: ChannelType.GuildForum,
                topic: 'Post any bug reports here!',
                availableTags: [
                    { name: 'Critical', emoji: '🔥' },
                    { name: 'Minor', emoji: '🐞' },
                    { name: 'Suggestion', emoji: '💡' }
                ]
            });

            await forum.permissionOverwrites.set([
                {
                    id: guild.roles.everyone.id,
                    deny: [
                        PermissionsBitField.Flags.CreatePublicThreads,
                        PermissionsBitField.Flags.CreatePrivateThreads
                    ]
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.CreatePublicThreads,
                        PermissionsBitField.Flags.CreatePrivateThreads
                    ]
                }
            ]);

            return inter.reply({ content: `✅ Bug forum created and locked: ${forum}`, ephemeral: true });
        }

        case 'report-bug': {
            const {
                ModalBuilder,
                ActionRowBuilder,
                TextInputBuilder,
                TextInputStyle
            } = require('discord.js');

            const makeInput = (id, label, style = 'SHORT', placeholder = '') =>
                new TextInputBuilder()
                    .setCustomId(id)
                    .setLabel(label)
                    .setStyle(style === TextInputStyle.Paragraph || style === 'PARAGRAPH' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder(placeholder);

            const modal = new ModalBuilder()
                .setCustomId('mod|Bug Report')
                .setTitle('🐛 Bug Report Form');

            modal.addComponents(
                new ActionRowBuilder().addComponents(makeInput('shortTitle', 'Short Title', 'SHORT', 'e.g. Game Crash')),
                new ActionRowBuilder().addComponents(makeInput('overview', 'Incident Overview', 'PARAGRAPH', 'e.g. While driving my game crashed...')),
                new ActionRowBuilder().addComponents(makeInput('steps', 'Steps To Reproduce bug', 'PARAGRAPH', 'e.g. Drive DOM3 into a wall...')),
                new ActionRowBuilder().addComponents(makeInput('expected', 'Expected Behavior', 'PARAGRAPH', 'e.g. I believe I shouldn\'t have crashed...')),
                new ActionRowBuilder().addComponents(makeInput('readGuide', 'Did you read bug report guide?', 'SHORT', 'Yes/No'))
            );

            return inter.showModal(modal);
        }

        case 'qa-stats': {
            const target = options.getUser('user') || inter.user;
            if (target.id !== inter.user.id) {
                if (!hasRole(member, config, 'lead')) {
                    return inter.reply({ ephemeral: true, content: '❌ Only Lead QA can view other users.' });
                }
            }

            const s = qaStats.summary(target.id);
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
                .setTitle(`QA Stats — ${target.tag}`)
                .setDescription(lines.join('\n'))
                .setColor(0x2b2d31)
                .setTimestamp();

            return inter.reply({ ephemeral: true, embeds: [emb] });
        }

        case 'qa-stats-panel': {
            const panel = new EmbedBuilder()
                .setTitle('QA Stats Panel')
                .setDescription('Click **My Stats** to view your QA performance privately.')
                .setColor(0x5865F2)
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('qa|mystats').setLabel('My Stats').setStyle(ButtonStyle.Primary)
            );

            return inter.reply({ embeds: [panel], components: [row] });
        }
    }
};
