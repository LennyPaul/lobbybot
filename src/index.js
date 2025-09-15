// src/index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import { connectMongo } from "./db/mongo.js";
import { refreshQueuePanel, handleSetup, handleQueueButtons, handleQueueReadyConfig, maybeLaunchReadyCheckOrStart } from "./features/queuePanel.js";
import { handleFill, handleClearQueue } from "./features/adminSim.js";
import { handleForceWin } from "./features/adminForce.js";

// ✅ Veto: commandes admin (avec rôles) depuis vetoAdmin.js
import { handleVetoConfig, handleVetoShowConfig, handleVetoSetCaptain } from "./features/vetoAdmin.js";
// ✅ Veto: boutons joueurs (ban map) depuis veto.js
import { handleVetoButton } from "./features/veto.js";

import { handleVoteButton, tryStartMatch } from "./features/matchFlow.js";
import { handleMatchReverse, handleMatchCancel, handleMatchSetWinner } from "./features/adminMatch.js";
import { handleSetupLeaderboard, handleSetupMatchHistory } from "./features/boards.js";
import { handleAdminRolesSet, handleAdminRolesShow } from "./features/adminRoles.js";
import { handleWipePlayers } from "./features/adminWipe.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.on(Events.ClientReady, async () => {
  console.log(`[BOT] Connecté en tant que ${client.user.tag}`);
  try {
    await connectMongo();
    console.log("[BOT] MongoDB connecté.");
  } catch (e) {
    console.error("[BOT][ERR] Échec Mongo:", e);
    process.exit(1);
  }

  try { await refreshQueuePanel(client); } catch {}
  try { await maybeLaunchReadyCheckOrStart(client); } catch {}
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      // Admin queue & setup
      if (name === "setup") return handleSetup(interaction);
      if (name === "fill") return handleFill(interaction, client);
      if (name === "clearqueue") return handleClearQueue(interaction, client);
      if (name === "queue_ready") return handleQueueReadyConfig(interaction);


      // ✅ Veto (admin via vetoAdmin.js)
      if (name === "veto_config") return handleVetoConfig(interaction, client);
      if (name === "veto_show_config") return handleVetoShowConfig(interaction);
      if (name === "veto_set_captain") return handleVetoSetCaptain(interaction, client);

      // Force win / Match admin
      if (name === "forcewin") return handleForceWin(interaction, client);
      if (name === "match_reverse") return handleMatchReverse(interaction, client);
      if (name === "match_cancel") return handleMatchCancel(interaction, client);
      if (name === "match_set_winner") return handleMatchSetWinner(interaction, client);

      // Boards
      if (name === "setup_leaderboard") return handleSetupLeaderboard(interaction, client);
      if (name === "setup_match_history") return handleSetupMatchHistory(interaction, client);

      // Gestion des rôles
      if (name === "admin_roles_set") return handleAdminRolesSet(interaction, client);
      if (name === "admin_roles_show") return handleAdminRolesShow(interaction, client);

      //Wype data
      if (name === "wipe_players") return handleWipePlayers(interaction, client);

      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith("queue_")) return handleQueueButtons(interaction, client);
      if (id.startsWith("veto_ban_")) return handleVetoButton(interaction, client);
      if (id.startsWith("vote_")) return handleVoteButton(interaction, client);
      return;
    }
  } catch (e) {
    console.error("[Interaction ERR]:", e);
    try {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "Erreur inattendue.", ephemeral: true });
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
