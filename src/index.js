// src/index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import { connectMongo } from "./db/mongo.js";

// Queue / Ready-check
import {
  refreshQueuePanel,
  handleSetup,
  handleQueueButtons,
  handleQueueReadyConfig,
  maybeLaunchReadyCheckOrStart,
} from "./features/queuePanel.js";

// Admin simulateurs file
import { handleFill, handleClearQueue } from "./features/adminSim.js";
import { handleSetupCancelLog, handleCancelAdjust } from "./features/cancelLog.js";

// Admin force / matchs
import { handleForceWin } from "./features/adminForce.js";
import { handleMatchReverse, handleMatchCancel, handleMatchSetWinner } from "./features/adminMatch.js";

// Veto
import { handleVetoButton } from "./features/veto.js";
import { handleVetoConfig, handleVetoShowConfig, handleVetoSetCaptain } from "./features/vetoAdmin.js";

// Votes / démarrage match
import { handleVoteButton, tryStartMatch } from "./features/matchFlow.js";

// Boards
import { handleSetupLeaderboard, handleSetupMatchHistory } from "./features/boards.js";

// Gestion rôles admin
import { handleAdminRolesSet, handleAdminRolesShow, handleAdminRolesKeys } from "./features/adminRoles.js";

// Wipe players (protégé par mot de passe)
import { handleWipePlayers } from "./features/adminWipe.js";

//Gestion demandes
import {
  handleOnbPanel,
  handleOnbSettings,
  handleOnbStart,
  handleOnbRulesButton,
  handleOnbModalSubmit,
  handleOnbAdminButtons,
} from "./features/onboarding.js";

import { handleRulesPanelCommand, handleAcceptRoleButton } from "./features/roleButton.js";

import { handleSay } from "./features/announce.js";



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
  // ⚠️ si déjà 10 joueurs au démarrage, on lance le ready-check
  try { await maybeLaunchReadyCheckOrStart(client); } catch {}
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === "rules_panel") return handleRulesPanelCommand(interaction);
      if (name === "say") return handleSay(interaction);

      //Onboarding
      if (name === "onboarding_panel")   return handleOnbPanel(interaction);
      if (name === "onboarding_settings") return handleOnbSettings(interaction);

      // Setup & file
      if (name === "setup") return handleSetup(interaction);
      if (name === "fill") return handleFill(interaction, client);
      if (name === "clearqueue") return handleClearQueue(interaction, client);
      if (name === "queue_settings") return handleQueueReadyConfig(interaction);


      // Veto (admin)
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

      // Rôles admin
      if (name === "admin_roles_set") return handleAdminRolesSet(interaction, client);
      if (name === "admin_roles_show") return handleAdminRolesShow(interaction, client);
      if (name === "admin_roles_keys") return handleAdminRolesKeys(interaction);


      // Wipe players (mdp)
      if (name === "wipe_players") return handleWipePlayers(interaction, client);

      // Log afk
      if (name === "setup_cancel_log") return handleSetupCancelLog(interaction);
      if (name === "cancel_adjust") return handleCancelAdjust(interaction);


      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith("accept_role_")) return handleAcceptRoleButton(interaction);

      if (interaction.customId === "onb_start") return handleOnbStart(interaction);
      if (interaction.customId.startsWith("onb_accept_") || interaction.customId.startsWith("onb_reject_")) {
        return handleOnbDecision(interaction);
      }

      if (id.startsWith("onb_start:"))        return handleOnbStart(interaction);
      if (id.startsWith("onb_rules_"))        return handleOnbRulesButton(interaction);
      if (id.startsWith("onb_admin_"))        return handleOnbAdminButtons(interaction);

      // ✅ Route aussi les boutons "rc_*" (ready-check) vers le handler de la file
      if (id.startsWith("queue_") || id.startsWith("rc_")) {
        return handleQueueButtons(interaction, client);
      }

      if (id.startsWith("veto_ban_")) return handleVetoButton(interaction, client);
      if (
        id.startsWith("vote_") ||          // (si anciens boutons traînent)
        id.startsWith("capvote_") ||       // ✅ nouveaux boutons capitaines
        id.startsWith("admin_setwin_")     // ✅ boutons décision admin
      ) {
        return handleVoteButton(interaction, client);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
       if (interaction.customId.startsWith("onb_modal:")) return handleOnbModalSubmit(interaction);
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
