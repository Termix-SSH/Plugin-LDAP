/**
 * Termix roles for an LDAP user: default roles every user of a provider gets,
 * plus roles mapped from the directory groups they are in.
 */

export interface LdapGroup {
  cn: string;
  dn: string;
}

export function normalizeDn(dn: string): string {
  return dn
    .split(/(?<!\\),/)
    .map((rdn) =>
      rdn
        .split(/(?<!\\)=/)
        .map((part) => part.trim())
        .join("="),
    )
    .join(",")
    .toLowerCase();
}

/** Comma or newline separated role names. */
export function parseRoleList(raw?: string | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * One `group:role` pair per line. The group is a cn or a full DN (DNs have
 * commas, so pairs are never comma separated). Splits on the last colon.
 * Bad lines are skipped so one typo never blocks sign in.
 */
export function parseRoleMap(
  raw?: string | null,
): Array<{ group: string; role: string }> {
  if (!raw) return [];
  const pairs: Array<{ group: string; role: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.lastIndexOf(":");
    if (separator <= 0) continue;
    const group = trimmed.slice(0, separator).trim();
    const role = trimmed.slice(separator + 1).trim();
    if (group && role) pairs.push({ group, role });
  }
  return pairs;
}

function inGroup(groups: LdapGroup[], wanted: string): boolean {
  const asDn = normalizeDn(wanted);
  const asCn = wanted.toLowerCase();
  return groups.some(
    (group) =>
      group.cn.toLowerCase() === asCn || normalizeDn(group.dn) === asDn,
  );
}

/**
 * What core should sync. `groups` is null when the group lookup failed, so
 * mapped roles are left as they are instead of being taken away.
 */
export function resolveLdapRoles({
  groups,
  roleMap,
  defaultRoles,
}: {
  groups: LdapGroup[] | null;
  roleMap: Array<{ group: string; role: string }>;
  defaultRoles: string[];
}): { desired: string[]; managed: string[] } | undefined {
  if (roleMap.length === 0 && defaultRoles.length === 0) return undefined;
  const desired = new Set(defaultRoles);
  const managed = new Set<string>();
  if (groups) {
    for (const { group, role } of roleMap) {
      managed.add(role);
      if (inGroup(groups, group)) desired.add(role);
    }
  }
  // Default roles are never taken away by a group change.
  for (const role of defaultRoles) managed.delete(role);
  return { desired: [...desired], managed: [...managed] };
}
