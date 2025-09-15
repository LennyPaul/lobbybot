// src/lib/auth.js
export async function requireAdminKey(interaction) {
  const provided = interaction.options.getString("key", true);
  const expected = process.env.ADMIN_KEY;

  if (!expected) {
    try {
      await interaction.reply({
        content: "⛔ ADMIN_KEY est manquant dans `.env` — impossible d’exécuter la commande.",
        ephemeral: true,
      });
    } catch {}
    return false;
  }

  if (provided !== expected) {
    try {
      await interaction.reply({ content: "⛔ Mot de passe invalide.", ephemeral: true });
    } catch {}
    return false;
  }

  return true;
}
