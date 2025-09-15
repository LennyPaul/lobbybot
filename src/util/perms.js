export function isAdmin(interaction) {
  const member = interaction.member;
  if (!member) return false;

  // Option 1 : rôle dédié
  const roleId = process.env.ADMIN_ROLE_ID;
  if (roleId && member.roles?.cache?.has(roleId)) return true;

  // Option 2 : permissions serveur
  const perms = member.permissions;
  return perms?.has("Administrator") || perms?.has("ManageGuild");
}
