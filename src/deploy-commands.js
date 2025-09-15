import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  // File d'attente / setup
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Poste le panneau de file d’attente (admin)"),

  new SlashCommandBuilder()
    .setName("fill")
    .setDescription("Ajoute N joueurs factices à la file (admin, dev)")
    .addIntegerOption(opt =>
      opt.setName("n")
        .setDescription("Nombre à ajouter (1-10)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)
    ),

new SlashCommandBuilder()
    .setName("clearqueue")
    .setDescription("Vide entièrement la file (admin)"),

    new SlashCommandBuilder()
  .setName("queue_ready")
  .setDescription("Configure le temps de validation (ready check) en secondes")
  .addIntegerOption(o =>
    o.setName("ready_seconds")
      .setDescription("Entre 10 et 600")
      .setMinValue(10)
      .setMaxValue(600)
      .setRequired(true)
  ),

  // Veto config
  new SlashCommandBuilder()
    .setName("veto_config")
    .setDescription("Configure le veto (capitaines, maps, durée par tour) [admin]")
    .addStringOption(opt =>
      opt.setName("captain_mode")
        .setDescription("random | highest")
        .setRequired(false)
        .addChoices(
          { name: "random (aléatoire)", value: "random" },
          { name: "highest (plus haut Elo)", value: "highest" },
        )
    )
    .addStringOption(opt =>
      opt.setName("maps")
        .setDescription("Liste de maps séparées par des virgules (laisser vide = défaut)")
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName("turn_seconds")
        .setDescription("Durée d’un tour en secondes (15–300)")
        .setRequired(false)
        .setMinValue(15)
        .setMaxValue(300)
    ),

  new SlashCommandBuilder()
    .setName("veto_show_config")
    .setDescription("Affiche la configuration actuelle du veto (admin)"),

  new SlashCommandBuilder()
    .setName("veto_set_captain")
    .setDescription("Change le capitaine d'une équipe pour un match (admin)")
    .addIntegerOption(opt =>
      opt.setName("match_id").setDescription("ID du match").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("team")
        .setDescription("Équipe")
        .setRequired(true)
        .addChoices(
          { name: "A", value: "A" },
          { name: "B", value: "B" },
        )
    )
    .addUserOption(opt =>
      opt.setName("user").setDescription("Nouveau capitaine (@mention)").setRequired(true)
    ),

  // Gestion de match (admin)
  new SlashCommandBuilder()
    .setName("forcewin")
    .setDescription("Force la victoire d'une équipe pour un match (admin)")
    .addIntegerOption(opt =>
      opt.setName("match_id").setDescription("ID du match").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("team")
        .setDescription("Équipe gagnante")
        .setRequired(true)
        .addChoices(
          { name: "A", value: "A" },
          { name: "B", value: "B" },
        )
    ),

  new SlashCommandBuilder()
    .setName("match_reverse")
    .setDescription("Annule un match terminé : rend l’Elo et marque 'reversed'")
    .addIntegerOption(opt =>
      opt.setName("match_id").setDescription("ID du match terminé").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("match_cancel")
    .setDescription("Annule une game non terminée (statut 'abandoned')")
    .addIntegerOption(opt =>
      opt.setName("match_id").setDescription("ID du match en cours").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("match_set_winner")
    .setDescription("Change l’équipe gagnante et recalcule l’Elo")
    .addIntegerOption(opt =>
      opt.setName("match_id").setDescription("ID du match").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("team")
        .setDescription("Nouvelle équipe gagnante")
        .setRequired(true)
        .addChoices(
          { name: "A", value: "A" },
          { name: "B", value: "B" },
        )
    ),

  // Boards / salons automatiques
  new SlashCommandBuilder()
    .setName("setup_leaderboard")
    .setDescription("Crée/actualise le salon #leaderboard (Elo + winrate) [admin]"),

  new SlashCommandBuilder()
    .setName("setup_match_history")
    .setDescription("Crée/actualise le salon #match-history (1 message par match) [admin]"),
    
  new SlashCommandBuilder()
  .setName("wipe_players")
  .setDescription("Purge les données joueurs. Conserve la config. [mot de passe]")
  .addBooleanOption(opt =>
    opt.setName("confirm")
      .setDescription("true pour confirmer")
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("key")
      .setDescription("Mot de passe admin (.env ADMIN_KEY)")
      .setRequired(true)
  ),

  new SlashCommandBuilder()
    .setName("admin_roles_set")
    .setDescription("Définit les rôles autorisés pour une commande (admin)")
    .addStringOption(opt =>
      opt.setName("command").setDescription("Nom exact de la commande (ex: forcewin)").setRequired(true)
    )
    .addRoleOption(opt => opt.setName("role1").setDescription("Rôle #1 autorisé").setRequired(false))
    .addRoleOption(opt => opt.setName("role2").setDescription("Rôle #2 autorisé").setRequired(false))
    .addRoleOption(opt => opt.setName("role3").setDescription("Rôle #3 autorisé").setRequired(false))
    .addRoleOption(opt => opt.setName("role4").setDescription("Rôle #4 autorisé").setRequired(false))
    .addRoleOption(opt => opt.setName("role5").setDescription("Rôle #5 autorisé").setRequired(false)),

  new SlashCommandBuilder()
    .setName("admin_roles_show")
    .setDescription("Affiche les rôles autorisés par commande (admin)"),

].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    // Astuce: vérifier les doublons côté code
    const names = commands.map(c => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) {
      console.error("Commandes en double dans le payload:", [...new Set(dupes)]);
      process.exit(1);
    }

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✓ Commandes déployées.");
  } catch (e) {
    console.error("Erreur déploiement commandes :", e);
    process.exit(1);
  }
})();
