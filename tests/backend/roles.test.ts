import { describe, expect, it } from "vitest";
import {
  parseRoleList,
  parseRoleMap,
  resolveLdapRoles,
} from "../../src/backend/roles.js";

describe("LDAP role settings", () => {
  it("reads role lists and group maps", () => {
    expect(parseRoleList(" support, readonly\nsupport ")).toEqual([
      "support",
      "readonly",
    ]);
    expect(
      parseRoleMap("devs:dev\ncn=ops,ou=groups,dc=x:ops\nbroken\n:nogroup"),
    ).toEqual([
      { group: "devs", role: "dev" },
      { group: "cn=ops,ou=groups,dc=x", role: "ops" },
    ]);
  });

  it("matches groups by cn or DN", () => {
    const roles = resolveLdapRoles({
      groups: [{ cn: "Devs", dn: "cn=Devs,ou=groups" }],
      roleMap: [
        { group: "devs", role: "dev" },
        { group: "CN=devs, OU=Groups", role: "builder" },
        { group: "ops", role: "ops" },
      ],
      defaultRoles: [],
    });
    expect(roles).toEqual({
      desired: ["dev", "builder"],
      managed: ["dev", "builder", "ops"],
    });
  });

  it("keeps mapped roles when the group lookup failed", () => {
    expect(
      resolveLdapRoles({
        groups: null,
        roleMap: [{ group: "devs", role: "dev" }],
        defaultRoles: ["support"],
      }),
    ).toEqual({ desired: ["support"], managed: [] });
  });

  it("never takes away a default role", () => {
    expect(
      resolveLdapRoles({
        groups: [],
        roleMap: [{ group: "devs", role: "support" }],
        defaultRoles: ["support"],
      }),
    ).toEqual({ desired: ["support"], managed: [] });
    expect(
      resolveLdapRoles({ groups: [], roleMap: [], defaultRoles: [] }),
    ).toBeUndefined();
  });
});
