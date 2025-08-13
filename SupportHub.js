// SupportHub.js
const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder
} = require('discord.js');

async function postSupportHub(inter, config) {
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setAuthor({ name: 'OUTBRK', iconURL: 'attachment://logo.png' })
        .setTitle('OUTBRK SUPPORT HUB')
        .setDescription(
            `Welcome to the OUTBRK Support Hub! Please read <#${config.faqChannelId}> before opening a ticket.\n` +
            `Select the option that corresponds with your request below.`
        )
        .addFields(
            { name: '🐛 BUG REPORT', value: 'Found a bug or glitch? Provide a detailed description and steps to reproduce so our team can address it promptly.', inline: false },
            { name: '🎮 PLAYER REPORT', value: 'Have you observed misconduct or rule violations? Share your evidence and any pertinent details here.', inline: false },
            { name: '⚖️ PUNISHMENT APPEAL', value: 'Wish to contest a penalty? Submit your reasoning and supporting information to have your case reconsidered.', inline: false },
            { name: '💬 OTHER', value: 'Have another request or inquiry? Let us know how we can assist!', inline: false }
        )
        .setImage('attachment://support-banner.png')
        .setFooter({ text: 'OUTBRK • SUPPORT' })
        .setTimestamp();

    const menu = new StringSelectMenuBuilder()
        .setCustomId('ticket_type')
        .setPlaceholder('Choose ticket type…')
        .addOptions([
            { label: 'Bug Report', value: 'Bug Report', emoji: '🐛', description: 'File a bug report' },
            { label: 'Player Report', value: 'Player Report', emoji: '🎮', description: 'Report misconduct' },
            { label: 'Punishment Appeal', value: 'Punishment Appeal', emoji: '⚖️', description: 'Appeal a penalty' },
            { label: 'Other', value: 'Other', emoji: '💬', description: 'General support' }
        ]);

    await inter.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
        files: [
            { attachment: './images/logo.png', name: 'logo.png' },
            { attachment: './images/support-banner.png', name: 'support-banner.png' }
        ]
    });
}

module.exports = { postSupportHub };
