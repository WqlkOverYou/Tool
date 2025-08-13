// index.js
// ──────────────────────────────────────────────────────────────────────────────
// 📦 Imports & Config
// ──────────────────────────────────────────────────────────────────────────────
const {
    Client,
    GatewayIntentBits,
    Partials,
} = require('discord.js');

const config = require('./config.json');
const registerCommands = require('./commands');
const { postSupportHub } = require('./SupportHub');

const {
    handleSelect,
    handleModal: handleTicketModal,
    handleButton: handleTicketButton,
    handleRemoteButton,
    handleRemoteSelect
} = require('./ticketHandlers');

// PlayFab admin module
const PlayFab = require('./playfab');

// ──────────────────────────────────────────────────────────────────────────────
// 📌 Client Setup
// ──────────────────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel]
});

process.on('unhandledRejection', console.error);

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerCommands(client, config);

    // Register PlayFab slash commands (guild-scoped) without touching other commands
    try {
        if (PlayFab?.pfPanelCommand) {
            await client.application.commands.create(
                PlayFab.pfPanelCommand().toJSON(),
                config.guildId
            );
        }
        if (PlayFab?.pfAccountCommand) {
            await client.application.commands.create(
                PlayFab.pfAccountCommand().toJSON(),
                config.guildId
            );
        }
    } catch (e) {
        console.error('❌ Failed to register PlayFab commands:', e);
    }
});

// expose client to handlers that need it
module.exports.client = client;
// also expose globally for safe DM helpers in PlayFab (non-invasive)
globalThis.client = client;

// ──────────────────────────────────────────────────────────────────────────────
// 🔄 Interaction Router (single, authoritative)
// ──────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async inter => {
    try {
        // Slash commands
        if (inter.isChatInputCommand()) {
            // Support hub
            if (inter.commandName === 'setup-support') {
                if (inter.member.id !== config.OnlyBOTAdmin)
                    return inter.reply({ content: '❌ Not authorized.', ephemeral: true });
                return postSupportHub(inter, config);
            }

            // PlayFab panels
            if (inter.commandName === 'pf-panel') {
                return PlayFab.postPanel(inter, config);
            }
            if (inter.commandName === 'pf-account') {
                return PlayFab.postAccount(inter, config);
            }

            // Defer to commands.js for the rest
            return require('./commands').handleSlash(inter, client, config);
        }

        // Ticket (local) UX
        if (inter.isStringSelectMenu() && inter.customId !== 'remote_manage_select')
            return handleSelect(inter, client, config);

        if (inter.isModalSubmit() && !inter.customId.startsWith('pf|') && !inter.customId.startsWith('pfacct|'))
            return handleTicketModal(inter, client, config);

        if (inter.isButton() &&
            !inter.customId.startsWith('remote|') &&
            !inter.customId.startsWith('pf|') &&
            !inter.customId.startsWith('pfacct|'))
            return handleTicketButton(inter, client, config);

        // Remote ticket mgmt
        if (inter.isButton() && inter.customId.startsWith('remote|'))
            return handleRemoteButton(inter, client, config);

        if (inter.isStringSelectMenu() && inter.customId === 'remote_manage_select')
            return handleRemoteSelect(inter, client, config);

        // PlayFab admin UI (buttons + modals)
        if (inter.isButton() && inter.customId.startsWith('pf|'))
            return PlayFab.handleButton(inter, config);

        if (inter.isModalSubmit() && inter.customId.startsWith('pf|'))
            return PlayFab.handleModal(inter, config);

        // PlayFab account standings (buttons + modals)
        if (inter.isButton() && inter.customId.startsWith('pfacct|'))
            return PlayFab.handleAccountButton(inter, config);

        if (inter.isModalSubmit() && inter.customId.startsWith('pfacct|'))
            return PlayFab.handleAccountModal(inter, config);

    } catch (err) {
        console.error('❌ Interaction error:', err);
        if (!inter.replied && !inter.deferred) {
            inter.reply({ ephemeral: true, content: `❌ Interaction error: ${err.message}` }).catch(() => { });
        }
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// 🔑 Login
// ──────────────────────────────────────────────────────────────────────────────
client.login(config.token);
