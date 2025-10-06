// src/features/voiceRooms.js
import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

/** Snowflake Discord: chaîne numérique */
function isSnowflake(id) {
  return typeof id === "string" && /^\d{5,}$/.test(id);
}

/** Retourne uniquement les IDs de membres valides (présents dans la guild) */
async function filterGuildMemberIds(guild, ids = []) {
  if (!guild) return [];
  const unique = Array.from(new Set(ids)).filter(isSnowflake);

  // Tente d'utiliser le cache + fetch ciblé pour les manquants
  const result = [];
  const toFetch = [];
  for (const id of unique) {
    if (guild.members.cache.has(id)) {
      result.push(id);
    } else {
      toFetch.push(id);
    }
  }

  // fetch en lot (rate-limit safe : on essaie un par un si besoin)
  for (const id of toFetch) {
    try {
      const m = await guild.members.fetch(id);
      if (m) result.push(id);
    } catch {
      // pas membre ou introuvable → on ignore
    }
  }
  return result;
}

/**
 * Crée (ou récupère) la catégorie "VOCAUX GAMES".
 * @param {import("discord.js").Guild} guild
 * @returns {Promise<import("discord.js").CategoryChannel | null>}
 */
export async function ensureVoiceCategory(guild) {
  if (!guild) return null;
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "vocaux games"
  );
  if (category) return category;

  category = await guild.channels.create({
    name: "VOCAUX GAMES",
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
        ],
      },
    ],
  });
  return category;
}

/**
 * Crée deux salons vocaux pour le match avec permissions privées par équipe.
 * Filtre automatiquement les IDs invalides / non-membres (ex: comptes fake).
 *
 * @param {import("discord.js").Guild} guild
 * @param {number} matchId
 * @param {string[]} teamAIds
 * @param {string[]} teamBIds
 * @returns {Promise<{voiceCategoryId: string|null, voiceAChannelId: string, voiceBChannelId: string}>}
 */
export async function createMatchVoiceChannels(guild, matchId, teamAIds = [], teamBIds = []) {
  if (!guild) throw new Error("Guild manquant pour createMatchVoiceChannels");

  // ⬇️ Filtre les IDs pour ne garder que des membres valides du serveur
  const validA = await filterGuildMemberIds(guild, teamAIds);
  const validB = await filterGuildMemberIds(guild, teamBIds);

  const category = await ensureVoiceCategory(guild);

  // Base: tout le monde interdit
  const overwritesBase = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
      ],
    },
  ];

  // Autorisations par équipe (si aucun membre valide, le salon reste privé à tous)
  const overwritesTeamA = [
    ...overwritesBase,
    ...validA.map((uid) => ({
      id: uid,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
      ],
    })),
  ];

  const overwritesTeamB = [
    ...overwritesBase,
    ...validB.map((uid) => ({
      id: uid,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
      ],
    })),
  ];

  const voiceA = await guild.channels.create({
    name: `Match #${matchId} — Équipe A`,
    type: ChannelType.GuildVoice,
    rtcRegion: "rotterdam",
    parent: category?.id,
    permissionOverwrites: overwritesTeamA,
  });

  const voiceB = await guild.channels.create({
    name: `Match #${matchId} — Équipe B`,
    type: ChannelType.GuildVoice,
    rtcRegion: 'rotterdam',
    parent: category?.id,
    permissionOverwrites: overwritesTeamB,
  });

  return {
    voiceCategoryId: category?.id ?? null,
    voiceAChannelId: voiceA.id,
    voiceBChannelId: voiceB.id,
  };
}

/**
 * Supprime les deux salons vocaux d’un match (optionnel mais conseillé à la fin).
 * @param {import("discord.js").Guild} guild
 * @param {{ voiceAChannelId?: string, voiceBChannelId?: string }} matchDoc
 */
export async function cleanupMatchVoiceChannels(guild, matchDoc = {}) {
  if (!guild) return;
  const ids = [matchDoc.voiceAChannelId, matchDoc.voiceBChannelId].filter(Boolean);
  for (const id of ids) {
    try {
      const ch = await guild.channels.fetch(id).catch(() => null);
      if (ch) await ch.delete().catch(() => {});
    } catch { /* ignore */ }
  }
}

