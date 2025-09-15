// src/features/adminSim.js
import { col } from "../db/models.js";
import { refreshQueuePanel, maybeLaunchReadyCheckOrStart } from "./queuePanel.js";

export async function handleFill(interaction, client) {
  const count = interaction.options.getInteger("count") ?? 10;

  // crée des faux users (si besoin) ou prend des membres du serveur
  const guild = interaction.guild;
  const members = await guild.members.fetch();
  const pool = members.filter(m => !m.user.bot);

  const now = new Date();

  let added = 0;
  for (const m of pool.values()) {
    if (added >= count) break;
    const userId = m.id;
    const exists = await col("queue").findOne({ userId });
    if (exists) continue;

    await col("players").updateOne(
      { userId },
      { $setOnInsert: { userId, rating: 1000, gamesPlayed: 0, banned: false, createdAt: now }, $set: { updatedAt: now } },
      { upsert: true }
    );
    await col("queue").insertOne({ userId, joinedAt: new Date(now.getTime() + added) });
    added++;
  }

  await interaction.reply({ content: `File remplie à +${added}.`, ephemeral: true });
  await refreshQueuePanel(client);
  await maybeLaunchReadyCheckOrStart(client);
}

export async function handleClearQueue(interaction, client) {
  await col("queue").deleteMany({});
  await col("ready_checks").deleteMany({ status: "pending" });
  await interaction.reply({ content: "File vidée.", ephemeral: true });
  await refreshQueuePanel(client);
}
