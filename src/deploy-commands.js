import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { ChannelType } from "discord.js";


const commands = [
  // File d'attente / setup
new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Poste le panneau de file d’attente (admin)"),

new SlashCommandBuilder()
  .setName("fill")
  .setDescription("Remplir la file pour tester (avec membres et/ou fakes)")
  .addIntegerOption(o =>
    o.setName("count")
      .setDescription("Nombre à ajouter (défaut 10)")
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(false)
  )
  .addBooleanOption(o =>
    o.setName("use_fakes")
      .setDescription("Compléter avec des faux joueurs si besoin (défaut: oui)")
      .setRequired(false)
  )
  .addBooleanOption(o =>
    o.setName("auto_confirm_fakes")
      .setDescription("Confirmer automatiquement les fakes dans le ready-check")
      .setRequired(false)
  ),

new SlashCommandBuilder()
    .setName("clearqueue")
    .setDescription("Vide entièrement la file (admin)"),

new SlashCommandBuilder()
  .setName("queue_settings")
  .setDescription("Configurer la file (ready-check on/off et délai)")
  .addBooleanOption(o =>
    o.setName("enabled")
     .setDescription("Activer le ready-check (true) ou lancer direct (false)")
     .setRequired(false)
  )
  .addIntegerOption(o =>
    o.setName("ready_seconds")
     .setDescription("Délai du ready-check en secondes (10..600)")
     .setMinValue(10)
     .setMaxValue(600)
     .setRequired(false)
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
  .setName("admin_roles_keys")
  .setDescription("Afficher la liste de TOUTES les autorisations possibles (et leur configuration actuelle)"),


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
    .setDescription("Affiche les rôles autorisés par commande (admin)")
    .addStringOption(o => o.setName("key").setDescription("ex: veto_set_captain").setRequired(false)),

// /onboarding_panel
new SlashCommandBuilder()
  .setName("onboarding_panel")
  .setDescription("Créer le panneau d’inscription (bouton Commencer l'inscription)")
  .addChannelOption(o =>
    o.setName("channel")
     .setDescription("Salon texte pour afficher le panneau")
     .addChannelTypes(ChannelType.GuildText)
     .setRequired(true)
  ),

// /onboarding_settings (ajout de l'option rules)
new SlashCommandBuilder()
  .setName("onboarding_settings")
  .setDescription("Configurer l’inscription (questions, rôle, salon review, timeout, règlement)")
  .addRoleOption(o =>
    o.setName("role")
     .setDescription("Rôle à attribuer à l’acceptation")
     .setRequired(false)
  )
  .addChannelOption(o =>
    o.setName("review_channel")
     .setDescription("Salon où les admins reçoivent les demandes")
     .addChannelTypes(ChannelType.GuildText)
     .setRequired(false)
  )
  .addIntegerOption(o =>
    o.setName("timeout")
     .setDescription("Temps max (secondes, 60-3600)")
     .setMinValue(60).setMaxValue(3600)
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("questions")
     .setDescription("Questions séparées par | (max 5)")
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("rules")
     .setDescription("Texte du règlement (affiché avant la modal)")
     .setRequired(false)
  ),


    // /onb_show_questions
  new SlashCommandBuilder()
    .setName("onb_show_questions")
    .setDescription("Voir les questions actuelles de l'inscription"),

  // /setup_cancel_log
new SlashCommandBuilder()
  .setName("setup_cancel_log")
  .setDescription("Configurer le salon de log des joueurs n'ayant pas accepté le ready-check")
  .addChannelOption(o =>
    o.setName("channel")
     .setDescription("Salon texte pour les logs")
     .addChannelTypes(ChannelType.GuildText)
     .setRequired(true)
  ),
// /cancel_adjust
new SlashCommandBuilder()
  .setName("cancel_adjust")
  .setDescription("Ajuster le compteur de non-validation de ready-check d'un joueur")
  .addUserOption(o =>
    o.setName("user")
     .setDescription("Joueur à modifier")
     .setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("amount")
     .setDescription("Valeur (si mode=add, peut être négative)")
     .setRequired(true)
  )
  .addStringOption(o =>
    o.setName("mode")
     .setDescription("add = ajout (par défaut), set = valeur exacte")
     .addChoices(
       { name: "add", value: "add" },
       { name: "set", value: "set" },
     )
     .setRequired(false)
  ),

new SlashCommandBuilder()
  .setName("rules_panel")
  .setDescription("Publier un règlement avec un bouton qui ajoute et/ou retire un rôle")
  .addRoleOption(o =>
    o.setName("role_add")
     .setDescription("Rôle à AJOUTER quand on clique")
     .setRequired(false)
  )
  .addRoleOption(o =>
    o.setName("role_remove")
     .setDescription("Rôle à RETIRER quand on clique")
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("text")
     .setDescription("Texte du règlement (le bot le découpe automatiquement)")
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("attachment")
     .setDescription("Fichier .txt contenant le règlement (optionnel)")
     .setRequired(false)
  )
  .addChannelOption(o =>
    o.setName("channel")
     .setDescription("Salon où poster (défaut: salon courant)")
     .addChannelTypes(ChannelType.GuildText)
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("button_place")
     .setDescription("Où placer le bouton")
     .addChoices(
       { name: "Sur le premier message", value: "first" },
       { name: "Sur le dernier message", value: "last" }
     )
     .setRequired(false)
  ),

  new SlashCommandBuilder()
  .setName("say")
  .setDescription("Poster un message avec le bot dans un salon choisi")
  .addChannelOption(o =>
    o.setName("channel")
     .setDescription("Salon cible (défaut: salon courant)")
     .addChannelTypes(ChannelType.GuildText)
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("text")
     .setDescription("Texte à envoyer (auto-découpé si trop long)")
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("attachment")
     .setDescription("Fichier .txt dont le contenu sera posté")
     .setRequired(false)
  )
  .addBooleanOption(o =>
    o.setName("embed")
     .setDescription("Envoyer en embed (auto-découpe > 4000)")
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("mentions")
     .setDescription("Politique de mentions")
     .addChoices(
       { name: "aucune mention", value: "none" },
       { name: "@users et @roles", value: "some" },
       { name: "@everyone / @here", value: "everyone" }
     )
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("file1")
     .setDescription("Fichier à joindre (image, pdf, etc.)")
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("file2")
     .setDescription("Fichier à joindre")
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("file3")
     .setDescription("Fichier à joindre")
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("file4")
     .setDescription("Fichier à joindre")
     .setRequired(false)
  )
  .addAttachmentOption(o =>
    o.setName("file5")
     .setDescription("Fichier à joindre")
     .setRequired(false)
  ),






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
