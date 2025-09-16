// src/features/veto.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { col } from "../db/models.js";

/** ========= CONFIG & CONSTANTS ========= **/
const DEFAULT_MAPS = [
  "Ascent", "Bind", "Haven", "Split", "Icebox",
  "Breeze", "Lotus", "Sunset", "Fracture", "Pearl"
];

const DEFAULT_TURN_SECONDS = 90;

// Timers par matchId (un seul message de veto par match)
const turnTimeouts = new Map();   // setTimeout pour l’auto-ban
const tickIntervals = new Map();  // setInterval pour le compte à rebours (1s)

function clearTimers(matchId) {
  const t = turnTimeouts.get(matchId);
  if (t) { clearTimeout(t); turnTimeouts.delete(matchId); }
  const i = tickIntervals.get(matchId);
  if (i) { clearInterval(i); tickIntervals.delete(matchId); }
}

function buildCaptainVoteComponents(matchId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`capvote_A_${matchId}`).setLabel("Équipe A a gagné").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`capvote_B_${matchId}`).setLabel("Équipe B a gagné").setStyle(ButtonStyle.Danger),
    ),
  ];
}


export async function getVetoConfig() {
  const cfg = await col("config").findOne({ _id: "veto" });
  return {
    captainMode: cfg?.captainMode ?? "random", // "random" | "highest"
    maps: (cfg?.maps?.length ? cfg.maps : DEFAULT_MAPS).slice(0),
    turnSeconds: Number.isFinite(cfg?.turnSeconds) ? cfg.turnSeconds : DEFAULT_TURN_SECONDS,
    updatedAt: cfg?.updatedAt ?? null,
  };
}

/**
 * /veto_config
 * - N’écrase QUE les paramètres fournis (les autres restent inchangés).
 * - Si "maps" est fourni mais vide (""), on remet le pool par défaut.
 */
export async function handleVetoConfig(interaction) {
  const providedMode = interaction.options.getString("captain_mode");       // peut être null
  const mapsStr = interaction.options.getString("maps");                    // peut être null
  const turnSecondsOpt = interaction.options.getInteger("turn_seconds");    // peut être null

  const current = await col("config").findOne({ _id: "veto" }) ?? {};
  const update = {};

  if (providedMode) update.captainMode = providedMode;

  if (typeof mapsStr === "string") {
    const maps = mapsStr.trim().length
      ? mapsStr.split(",").map(s => s.trim()).filter(Boolean)
      : DEFAULT_MAPS;
    update.maps = maps;
  }

  if (Number.isInteger(turnSecondsOpt)) {
    update.turnSeconds = turnSecondsOpt;
  }

  if (Object.keys(update).length === 0) {
    return interaction.reply({
      content: "Aucun paramètre fourni. Rien n’a été changé.",
      ephemeral: true,
    });
  }

  update.updatedAt = new Date();
  await col("config").updateOne(
    { _id: "veto" },
    { $set: update },
    { upsert: true }
  );

  const cfg = await getVetoConfig();
  await interaction.reply({
    content:
`Config veto mise à jour ✅
- Capitaines: **${cfg.captainMode}**
- Maps (${cfg.maps.length}): ${cfg.maps.join(", ")}
- Durée par tour: **${cfg.turnSeconds}s**`,
    ephemeral: true,
  });
}

export async function handleVetoShowConfig(interaction) {
  const cfg = await getVetoConfig();
  await interaction.reply({
    content:
`Config veto actuelle:
- Capitaines: **${cfg.captainMode}**
- Maps (${cfg.maps.length}): ${cfg.maps.join(", ")}
- Durée par tour: **${cfg.turnSeconds}s**`,
    ephemeral: true,
  });
}

/** ========= UI UNIQUE (VETO) =========
 * 1 seul message avec :
 * - Embed : capitaines, équipe au tour, compte à rebours
 * - Boutons : verts (dispo) cliquables / rouges (bannies) désactivés
 */
function buildVetoComponents(allMaps, remaining, matchId) {
  const remainingSet = new Set(remaining);
  const rows = [];
  let i = 0;
  while (i < allMaps.length) {
    const slice = allMaps.slice(i, i + 5);
    const row = new ActionRowBuilder();
    for (const m of slice) {
      const available = remainingSet.has(m);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`veto_ban_${matchId}::${m}`)
          .setLabel(m)
          .setStyle(available ? ButtonStyle.Success : ButtonStyle.Danger)
          .setDisabled(!available)
      );
    }
    rows.push(row);
    i += 5;
  }
  return rows;
}

function vetoEmbed(matchId, state, secondsLeft) {
  const { teamA = [], teamB = [], captainA, captainB, currentTeam } = state;
  const captainId = currentTeam === "A" ? captainA : currentTeam === "B" ? captainB : null;

  return new EmbedBuilder()
    .setTitle(`Veto — Match #${matchId}`)
    .setDescription(
      `**But :** bannir des maps jusqu’à n’en laisser **1**.\n` +
      `**Capitaines :** A → <@${captainA}> | B → <@${captainB}>\n` +
      (currentTeam
        ? `**Tour actuel :** Équipe **${currentTeam}** — Capitaine **<@${captainId}>**\n` +
          `**Temps restant :** ${Math.max(0, secondsLeft)}s`
        : `**Veto terminé**`)
    )
    .addFields(
      { name: "Équipe A", value: teamA.map(id => `<@${id}>`).join(", ") || "—", inline: true },
      { name: "Équipe B", value: teamB.map(id => `<@${id}>`).join(", ") || "—", inline: true },
    );
}

/** ========= MESSAGE #1 (récap équipes & capitaines) ========= */
export function buildRecapEmbed(matchId, teamAIds, teamBIds, captainA, captainB) {
  return new EmbedBuilder()
    .setTitle(`Match #${matchId} — Équipes & Capitaines`)
    .addFields(
      { name: "Équipe A", value: teamAIds.map(id => `• <@${id}>`).join("\n") || "—", inline: true },
      { name: "Équipe B", value: teamBIds.map(id => `• <@${id}>`).join("\n") || "—", inline: true },
      { name: "Capitaines", value: `A → <@${captainA}>\nB → <@${captainB}>` },
    )
    .setFooter({ text: "Ce message se mettra à jour si les capitaines changent." });
}

/** ========= CHOIX DES CAPITAINES ========= */
function pickCaptainRandom(teamIds) {
  return teamIds[Math.floor(Math.random() * teamIds.length)];
}

async function pickCaptainHighest(teamIds) {
  const players = await col("players")
    .find({ userId: { $in: teamIds } })
    .project({ userId: 1, rating: 1 })
    .toArray();
  if (!players.length) return pickCaptainRandom(teamIds);
  players.sort((a, b) => (b?.rating ?? 1000) - (a?.rating ?? 1000));
  return players[0].userId;
}

export async function computeCaptains(teamAIds, teamBIds) {
  const cfg = await getVetoConfig();
  if (cfg.captainMode === "highest") {
    const [a, b] = await Promise.all([
      pickCaptainHighest(teamAIds),
      pickCaptainHighest(teamBIds),
    ]);
    return { captainA: a, captainB: b };
  }
  return { captainA: pickCaptainRandom(teamAIds), captainB: pickCaptainRandom(teamBIds) };
}

/** ========= MAJ du message de veto ========= */
async function updateVetoMessage(client, matchId) {
  const state = await col("veto").findOne({ matchId });
  if (!state) return;

  const allMaps = state.allMaps || DEFAULT_MAPS;
  const remaining = state.remaining || [];
  const secondsLeft = state.turnEndsAt
    ? Math.ceil((new Date(state.turnEndsAt).getTime() - Date.now()) / 1000)
    : 0;

  try {
    const thread = await client.channels.fetch(state.threadId);
    const msg = await thread.messages.fetch(state.vetoMessageId);
    await msg.edit({
      embeds: [vetoEmbed(matchId, state, secondsLeft)],
      components: buildVetoComponents(allMaps, remaining, matchId),
    });
  } catch (e) {
    // message perdu ? on en reposte un et on mémorise l'id
    try {
      const thread = await client.channels.fetch(state.threadId);
      const sent = await thread.send({
        embeds: [vetoEmbed(matchId, state, secondsLeft)],
        components: buildVetoComponents(allMaps, remaining, matchId),
      });
      await col("veto").updateOne(
        { matchId },
        { $set: { vetoMessageId: sent.id, updatedAt: new Date() } }
      );
    } catch (e2) {
      console.warn("[veto] impossible de mettre à jour le message:", e2.message);
    }
  }
}

/** ========= PLANIFICATION D’UN TOUR ========= */
async function scheduleTurn(client, matchId, seconds) {
  clearTimers(matchId);

  const deadline = new Date(Date.now() + seconds * 1000);
  await col("veto").updateOne(
    { matchId },
    { $set: { turnEndsAt: deadline, updatedAt: new Date() } }
  );

  // tick UI chaque seconde
  const interval = setInterval(() => {
    updateVetoMessage(client, matchId).catch(() => {});
  }, 1000);
  tickIntervals.set(matchId, interval);

  // auto-ban à l’expiration
  const timeout = setTimeout(() => {
    autoBan(matchId, client).catch(err => console.error("[veto] autoBan error:", err));
  }, seconds * 1000);
  turnTimeouts.set(matchId, timeout);

  await updateVetoMessage(client, matchId);
}

/** ========= AUTO-BAN ========= */
async function autoBan(matchId, client) {
  clearTimers(matchId);

  const state = await col("veto").findOne({ matchId });
  if (!state || !state.currentTeam) return;

  const remaining = state.remaining || [];
  if (remaining.length <= 1) return;

  const randomMap = remaining[Math.floor(Math.random() * remaining.length)];
  await applyBan(client, matchId, randomMap, null, true);
}

/** ========= APPLIQUER UN BAN (manuel/auto) ========= */
async function applyBan(client, matchId, mapName, byUserId = null, isAuto = false) {
  const state = await col("veto").findOne({ matchId });
  if (!state || !state.currentTeam) return;

  const allMaps = state.allMaps || DEFAULT_MAPS;
  const remaining = state.remaining || [];
  if (!remaining.includes(mapName)) return;

  const newRemaining = remaining.filter(m => m !== mapName);
  const nextTeam = state.currentTeam === "A" ? "B" : "A";

  // Fin du veto → 1 map restante
  if (newRemaining.length === 1) {
    const picked = newRemaining[0];
    await col("veto").updateOne(
      { matchId },
      { $set: { remaining: newRemaining, currentTeam: null, picked, turnEndsAt: null, updatedAt: new Date() } }
    );
    clearTimers(matchId);

    // Mettre le message veto en état final + envoyer message #3 (Bonne game + vote)
    try {
      const thread = await client.channels.fetch(state.threadId);
      const msg = await (async () => {
        try { return await thread.messages.fetch(state.vetoMessageId); } catch { return null; }
      })();

      const finalEmbed = new EmbedBuilder()
        .setTitle(`Veto — Match #${matchId}`)
        .setDescription(`**Map sélectionnée : \`${picked}\`** ✅`)
        .addFields(
          { name: "Capitaine A", value: `<@${state.captainA}>`, inline: true },
          { name: "Capitaine B", value: `<@${state.captainB}>`, inline: true },
        );

      const components = buildVetoComponents(allMaps, newRemaining, matchId);
      if (msg) {
        await msg.edit({ embeds: [finalEmbed], components });
      } else {
        await thread.send({ embeds: [finalEmbed], components });
      }

      // === Message #3 : “Bonne game” + système de vote ===
const voteRows = buildCaptainVoteComponents(matchId);

const voteMsg = await thread.send({
  embeds: [
    new EmbedBuilder()
      .setTitle(`Match #${matchId} — Lancement !`)
      .setDescription(
        `**Bonne game à tous !** 🎮\n` +
        `À la fin de la partie, **seuls les CAPITAINES** votent ci-dessous.\n` +
        `- Si les 2 votes **coïncident**, la victoire est validée automatiquement.\n` +
        `- En cas de **désaccord**, le match part en **review admin**.`
      )
  ],
  components: voteRows,
});

// on mémorise la map choisie + l’ID du message de vote dans la collection matches
await col("matches").updateOne(
  { matchId },
  { $set: { pickedMap: picked, voteMessageId: voteMsg.id, updatedAt: new Date() } }
);
    } catch {}
    return;
  }

  // Continuer le veto
  await col("veto").updateOne(
    { matchId },
    { $set: { remaining: newRemaining, currentTeam: nextTeam, updatedAt: new Date() } }
  );

  // Replanifier un tour avec la durée configurée
  const cfg = await getVetoConfig();
  await scheduleTurn(client, matchId, cfg.turnSeconds);

  // ⚠️ NOTE: pas de thread.send ici (plus de messages joueurs).
}

/** ========= DÉMARRAGE DU VETO (message #2) =========
 * startVeto(client, matchId, threadId, teamAIds, teamBIds, recapMessageId, captains?)
 */
export async function startVeto(client, matchId, threadId, teamAIds, teamBIds, recapMessageId, captains) {
  const cfg = await getVetoConfig();
  const { captainA, captainB } = captains ?? await computeCaptains(teamAIds, teamBIds);

  const allMaps = cfg.maps.slice(0);
  const remaining = allMaps.slice(0);
  const currentTeam = "A"; // A commence

  const thread = await client.channels.fetch(threadId);

  // Message unique de veto (#2)
  const initialEmbed = vetoEmbed(
    matchId,
    { teamA: teamAIds, teamB: teamBIds, captainA, captainB, currentTeam },
    cfg.turnSeconds
  );

  const sent = await thread.send({
    embeds: [initialEmbed],
    components: buildVetoComponents(allMaps, remaining, matchId),
  });

  // Persist état veto
  await col("veto").updateOne(
    { matchId },
    {
      $set: {
        matchId,
        threadId,
        recapMessageId,          // message #1
        vetoMessageId: sent.id,  // message #2
        teamA: teamAIds,
        teamB: teamBIds,
        captainA,
        captainB,
        allMaps,
        remaining,
        currentTeam,
        turnEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    },
    { upsert: true }
  );

  // Démarrer le premier tour
  await scheduleTurn(client, matchId, cfg.turnSeconds);
}

/** ========= Interaction bouton veto ========= */
export async function handleVetoButton(interaction, client) {
  const id = interaction.customId; // "veto_ban_<matchId>::<map>"
  if (!id.startsWith("veto_ban_")) return false;

  const rest = id.slice("veto_ban_".length);
  const [matchIdStr, mapName] = rest.split("::");
  const matchId = parseInt(matchIdStr, 10);
  const userId = interaction.user.id;

  const state = await col("veto").findOne({ matchId });
  if (!state) {
    await interaction.reply({ content: "Veto introuvable pour ce match.", ephemeral: true });
    return true;
  }

  if (!state.currentTeam) {
    await interaction.reply({ content: "Le veto est déjà terminé.", ephemeral: true });
    return true;
  }

  const isCaptainTurn =
    (state.currentTeam === "A" && userId === state.captainA) ||
    (state.currentTeam === "B" && userId === state.captainB);

  if (!isCaptainTurn) {
    await interaction.reply({ content: "Seul le capitaine de l’équipe en cours peut bannir une map.", ephemeral: true });
    return true;
  }

  const remaining = state.remaining || [];
  if (!remaining.includes(mapName)) {
    await interaction.reply({ content: "Cette map n’est plus disponible.", ephemeral: true });
    return true;
  }

  // Réponse éphémère rapide (aucun message public)
  await interaction.deferUpdate().catch(() => {});
  await applyBan(client, matchId, mapName, userId, false);
  return true;
}

/** ========= MàJ du message #1 quand un capitaine change ========= */
export async function updateRecapForVeto(client, matchId) {
  const state = await col("veto").findOne({ matchId });
  if (!state?.recapMessageId) return;
  try {
    const thread = await client.channels.fetch(state.threadId);
    const msg = await thread.messages.fetch(state.recapMessageId);
    const embed = buildRecapEmbed(matchId, state.teamA, state.teamB, state.captainA, state.captainB);
    await msg.edit({ embeds: [embed] });
  } catch {}
}

// (Export explicite redondant pour s’assurer que buildRecapEmbed est bien présent dans le module)
export { buildVetoComponents }; // si tu en as besoin ailleurs
