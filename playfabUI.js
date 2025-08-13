// playfabUI.js
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder
} = require('discord.js');

const { makeInput } = require('./utils');
const PlayFab = require('./playfab');

function ownerGuard(inter, config) {
    if (inter.user.id !== config.OnlyBOTAdmin) {
        throw new Error('Only the designated owner may use PlayFab admin tools.');
    }
}

// Panel poster
async function postPlayFabPanel(inter, config) {
    const embed = new EmbedBuilder()
        .setTitle('PlayFab Administration')
        .setDescription(
            'Use the buttons below to **Ban**, **Mute (Vivox)**, or **Reset account**.\n' +
            'You can paste **PlayFabId**, **SteamID64**, **Steam profile URL** (/profiles/<id> or /id/<vanity>), ' +
            'or the **in-game display name**. (Vanity requires `steamWebApiKey` in config.)'
        )
        .setColor(0x2b2d31);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf|ban').setLabel('Ban').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('pf|mute').setLabel('Mute (Vivox)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('pf|reset').setLabel('Reset Account').setStyle(ButtonStyle.Secondary)
    );

    return inter.reply({ embeds: [embed], components: [row] });
}

// Buttons → show modals
async function handlePFButton(inter, client, config) {
    try { ownerGuard(inter, config); } catch (e) {
        return inter.reply({ ephemeral: true, content: `❌ ${e.message}` });
    }

    const [prefix, action] = inter.customId.split('|');

    if (action === 'ban') {
        const modal = new ModalBuilder()
            .setCustomId('pfmod|ban')
            .setTitle('PlayFab Ban')
            .addComponents(
                new ActionRowBuilder().addComponents(makeInput('target', 'Player (PFID/Steam URL/Name)', 'SHORT', 'e.g. https://steamcommunity.com/profiles/7656119…')),
                new ActionRowBuilder().addComponents(makeInput('reason', 'Reason', 'PARAGRAPH', 'e.g. Cheating')),
                new ActionRowBuilder().addComponents(makeInput('hours', 'Duration hours (blank = permanent)', 'SHORT', 'e.g. 72'))
            );
        return inter.showModal(modal);
    }

    if (action === 'mute') {
        const modal = new ModalBuilder()
            .setCustomId('pfmod|mute')
            .setTitle('PlayFab Vivox Mute')
            .addComponents(
                new ActionRowBuilder().addComponents(makeInput('target', 'Player (PFID/Steam URL/Name)', 'SHORT')),
                new ActionRowBuilder().addComponents(makeInput('reason', 'Displayed Reason', 'PARAGRAPH', 'Inappropriate language')),
                new ActionRowBuilder().addComponents(makeInput('expires', 'ISO Expiry', 'SHORT', '2025-12-30T15:30:00Z'))
            );
        return inter.showModal(modal);
    }

    if (action === 'reset') {
        const modal = new ModalBuilder()
            .setCustomId('pfmod|reset')
            .setTitle('Reset Account (Delete Title key: Save)')
            .addComponents(
                new ActionRowBuilder().addComponents(makeInput('target', 'Player (PFID/Steam URL/Name)', 'SHORT', 'e.g. WalkOverYou')),
                new ActionRowBuilder().addComponents(makeInput('confirm', 'Type YES to confirm', 'SHORT', 'YES'))
            );
        return inter.showModal(modal);
    }
}

// Modals → call PlayFab
async function handlePFModal(inter, client, config) {
    try { ownerGuard(inter, config); } catch (e) {
        return inter.reply({ ephemeral: true, content: `❌ ${e.message}` });
    }

    const [, action] = inter.customId.split('|');

    try {
        if (action === 'ban') {
            const target = inter.fields.getTextInputValue('target');
            const reason = inter.fields.getTextInputValue('reason');
            const hoursRaw = inter.fields.getTextInputValue('hours').trim();
            const hours = hoursRaw ? parseInt(hoursRaw, 10) : undefined;
            if (hoursRaw && Number.isNaN(hours)) {
                return inter.reply({ ephemeral: true, content: '❌ Duration must be a number of hours.' });
            }

            await inter.deferReply({ ephemeral: true });

            const { playfabId, account } = await PlayFab.resolvePlayerFromInput(target, config);
            await PlayFab.banPlayer(config, playfabId, reason, hours);

            const tag = account?.TitleInfo?.DisplayName || playfabId;
            return inter.editReply(`✅ Banned **${tag}** (PFID: \`${playfabId}\`) — ${reason}${hours ? ` for ${hours}h` : ' (permanent)'}.`);
        }

        if (action === 'mute') {
            const target = inter.fields.getTextInputValue('target');
            const reason = inter.fields.getTextInputValue('reason');
            const expires = inter.fields.getTextInputValue('expires').trim();

            if (!Date.parse(expires)) {
                return inter.reply({ ephemeral: true, content: '❌ Expiry must be a valid ISO timestamp like `2025-12-30T15:30:00Z`.' });
            }

            await inter.deferReply({ ephemeral: true });

            const { playfabId, account } = await PlayFab.resolvePlayerFromInput(target, config);
            await PlayFab.setMute(config, playfabId, reason, expires);

            const tag = account?.TitleInfo?.DisplayName || playfabId;
            return inter.editReply(`✅ Vivox mute set for **${tag}** (PFID: \`${playfabId}\`) until \`${expires}\` — ${reason}`);
        }

        if (action === 'reset') {
            const target = inter.fields.getTextInputValue('target');
            const confirm = inter.fields.getTextInputValue('confirm').trim().toUpperCase();
            if (confirm !== 'YES') {
                return inter.reply({ ephemeral: true, content: '❌ Cancelled — confirmation must be **YES**.' });
            }

            await inter.deferReply({ ephemeral: true });

            const { playfabId, account } = await PlayFab.resolvePlayerFromInput(target, config);
            await PlayFab.resetAccount(config, playfabId);

            const tag = account?.TitleInfo?.DisplayName || playfabId;
            return inter.editReply(`✅ Reset Title Player Data key **Save** for **${tag}** (PFID: \`${playfabId}\`).`);
        }
    } catch (e) {
        const msg = `❌ PlayFab error: ${e.message}`;
        if (!inter.deferred && !inter.replied) return inter.reply({ ephemeral: true, content: msg });
        return inter.editReply(msg);
    }
}

module.exports = {
    postPlayFabPanel,
    handlePFButton,
    handlePFModal
};
