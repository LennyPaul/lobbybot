// src/features/announce.js
import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { requireRole } from "../lib/roles.js";

/** Découpe un long texte en chunks de taille max. */
function split(text, max) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out.length ? out : [text];
}

/** Lit le contenu depuis l’option "text" ou un attachment .txt */
async function readTextOptionOrAttachment(interaction) {
  const txt = interaction.options.getString("text");
  const att = interaction.options.getAttachment("attachment");
  if (att) {
    // On attend un .txt ; Discord héberge le fichier via URL (fetch natif Node >=18)
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Lecture du fichier impossible (HTTP ${res.status})`);
    return (await res.text()).trim();
  }
  if (typeof txt === "string" && txt.trim().length) return txt.trim();
  throw new Error("Aucun contenu fourni. Renseigne `text` ou un fichier `.txt` dans attachment.");
}

/** Politique de mentions (sécurisée par défaut) */
function buildAllowedMentions(mode) {
  if (mode === "everyone") return { parse: ["everyone", "roles", "users"] };
  if (mode === "some")     return { parse: ["roles", "users"] };
  return { parse: [] }; // none
}

/** Récupère jusqu’à 5 fichiers à joindre tels quels */
function collectFiles(interaction) {
  const names = ["file1", "file2", "file3", "file4", "file5"];
  const files = [];
  for (const n of names) {
    const att = interaction.options.getAttachment(n);
    if (att) files.push(att);
  }
  return files;
}

/**
 * /say — Poster un message avec le bot (texte long, embed, fichiers, mentions)
 * Autorisations via /admin_roles_set key:say roles:@Admins
 */
export async function handleSay(interaction) {
  if (!(await requireRole(interaction, "say"))) return;

  const target = interaction.options.getChannel("channel") || interaction.channel;
  if (target.type !== ChannelType.GuildText) {
    return interaction.reply({ content: "Choisis un salon **texte**.", ephemeral: true });
  }

  const asEmbed = interaction.options.getBoolean("embed") || false;
  const mentionsMode = interaction.options.getString("mentions") || "none";
  const allowedMentions = buildAllowedMentions(mentionsMode);
  const files = collectFiles(interaction);

  // Permissions
  const me = interaction.guild.members.me;
  const perms = me?.permissionsIn(target);
  if (!perms?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({ content: "⛔ Le bot ne peut pas envoyer de messages ici.", ephemeral: true });
  }
  if (asEmbed && !perms.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: "⛔ Il manque la permission **Intégrer des liens** (Embed Links).", ephemeral: true });
  }
  if (files.length && !perms.has(PermissionFlagsBits.AttachFiles)) {
    return interaction.reply({ content: "⛔ Il manque la permission **Joindre des fichiers** (AttachFiles).", ephemeral: true });
  }

  // Contenu
  let content;
  try {
    content = await readTextOptionOrAttachment(interaction);
  } catch (e) {
    return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }

  // Envoi
  if (asEmbed) {
    const chunks = split(content, 4000); // limite embed.description
    for (let i = 0; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setTitle(i === 0 ? "Message" : `Suite (${i + 1})`)
        .setDescription(chunks[i]);

      const payload = { embeds: [embed], allowedMentions };
      if (i === 0 && files.length) payload.files = files; // fichiers seulement au 1er envoi

      if (i === 0 && target.id === interaction.channelId && !interaction.deferred && !interaction.replied) {
        await interaction.reply(payload);
      } else {
        await target.send(payload);
        if (i === 0 && target.id !== interaction.channelId && !interaction.replied) {
          // Confirme en éphemère si posté dans un autre salon
          try { await interaction.reply({ content: "✅ Message envoyé.", ephemeral: true }); } catch {}
        }
      }
    }
  } else {
    const chunks = split(content, 2000); // limite message normal
    for (let i = 0; i < chunks.length; i++) {
      const payload = { content: chunks[i], allowedMentions };
      if (i === 0 && files.length) payload.files = files; // fichiers au 1er envoi

      if (i === 0 && target.id === interaction.channelId && !interaction.deferred && !interaction.replied) {
        await interaction.reply(payload);
      } else {
        await target.send(payload);
        if (i === 0 && target.id !== interaction.channelId && !interaction.replied) {
          try { await interaction.reply({ content: "✅ Message envoyé.", ephemeral: true }); } catch {}
        }
      }
    }
  }
}
