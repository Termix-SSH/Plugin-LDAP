/**
 * LDAP sign-in as a form login method: a service bind to find the user, a
 * bind as the user to check the password, then an optional admin group
 * lookup. Core finds or provisions the user and issues the session.
 */

import ldap from "ldapjs";
import {
  LoginMethodError,
  type PluginContext,
  type PluginLoginRequest,
  type PluginVerifiedIdentity,
} from "@termix-ssh/plugin-sdk/backend";
import type { ProviderStore } from "./providers.js";
import type { LdapConfig } from "./types.js";

export const METHOD_ID = "ldap";

function ldapEscapeFilter(value: string): string {
  return value.replace(
    /[\\*()\x00]/g,
    (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * A DN for comparing: LDAP matches DNs without case, and directories differ
 * on spaces around the commas and equals signs.
 */
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

/** The provider id identities from this directory are stored under. */
export function identityProvider(providerId: number): string {
  return `ldap:${providerId}`;
}

/** TLS settings for LDAPS: verified by default, against an optional CA. */
export function ldapTlsOptions(
  config: LdapConfig,
): { rejectUnauthorized: boolean; ca?: string[] } | undefined {
  if (!config.useTLS) return undefined;
  const ca = config.tlsCaCert?.trim();
  return {
    rejectUnauthorized: !config.tlsSkipVerify,
    ...(ca ? { ca: [ca] } : {}),
  };
}

const CONNECT_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 15_000;

/** Options for a client to this directory, with timeouts so a login can't hang. */
export function ldapClientOptions(config: LdapConfig): ldap.ClientOptions {
  const useTLS = !!config.useTLS;
  const port = config.port || (useTLS ? 636 : 389);
  return {
    url: `${useTLS ? "ldaps" : "ldap"}://${config.host}:${port}`,
    tlsOptions: ldapTlsOptions(config),
    connectTimeout: CONNECT_TIMEOUT_MS,
    timeout: OPERATION_TIMEOUT_MS,
  };
}

function createClient(config: LdapConfig, log: PluginContext["log"]) {
  const client = ldap.createClient(ldapClientOptions(config));
  // Connection failures also reach the pending bind, but ldapjs emits them
  // again as "error" and throws when nothing listens.
  client.on("error", (error: Error) => {
    log.warn(`LDAP connection to ${config.host} failed: ${error.message}`);
  });
  return client;
}

function bind(client: ldap.Client, dn: string, password: string) {
  return new Promise<void>((resolve, reject) => {
    client.bind(dn, password, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * ldapjs re-serializes a search base with non-ASCII characters hex-escaped,
 * which Active Directory rejects. Hand it a parsed DN that still prints as
 * the text the admin entered.
 */
export function searchBaseDn(base: string): ldap.DN {
  const dn = ldap.parseDN(base);
  Object.defineProperty(dn, "toString", { value: () => base });
  return dn;
}

function search(
  client: ldap.Client,
  base: string,
  filter: string,
  attributes: string[],
): Promise<ldap.SearchEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ldap.SearchEntry[] = [];
    client.search(
      searchBaseDn(base),
      { filter, attributes, scope: "sub" },
      (err, res) => {
        if (err) return reject(err);
        res.on("searchEntry", (entry) => entries.push(entry));
        res.on("error", reject);
        res.on("end", () => resolve(entries));
      },
    );
  });
}

function unbind(client: ldap.Client): void {
  try {
    client.unbind();
  } catch {
    // best effort
  }
}

function firstValue(entry: ldap.SearchEntry, key: string): string {
  const attr = entry.attributes.find((a) => a.type === key);
  if (!attr) return "";
  return Array.isArray(attr.values) ? attr.values[0] : String(attr.values);
}

export function createLdapLogin(ctx: PluginContext, store: ProviderStore) {
  return async function verify(
    request: PluginLoginRequest,
    instanceId: string | null,
  ): Promise<PluginVerifiedIdentity> {
    const body = request.body ?? {};
    const providerId = Number(instanceId ?? body.providerId);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!Number.isInteger(providerId) || !username || !password) {
      throw new LoginMethodError(
        "providerId, username, and password are required",
        400,
      );
    }

    // Same limits as password login: an LDAP bind is a password guess.
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `${providerId}:${username}`;
    const lock = await ctx.auth.loginRateLimit.isLocked(clientIp, rateLimitKey);
    if (lock.locked) {
      const error = new LoginMethodError(
        "Too many login attempts. Please try again later.",
        429,
      );
      Object.assign(error, { remainingTime: lock.remainingTime });
      throw error;
    }

    const provider = await store.find(providerId);
    if (!provider || !provider.enabled) {
      throw new LoginMethodError("LDAP provider not found", 404);
    }
    const config = provider.config;
    if (
      !config.host ||
      !config.bindDN ||
      !config.userSearchBase ||
      !config.userSearchFilter
    ) {
      throw new LoginMethodError("LDAP provider is misconfigured", 500);
    }

    const refuse = async (reason: string) => {
      await ctx.auth.loginRateLimit.recordFailure(clientIp, rateLimitKey);
      ctx.log.warn(`LDAP login refused for ${username}: ${reason}`);
      return new LoginMethodError("Invalid username or password", 401);
    };

    const serviceClient = createClient(config, ctx.log);
    try {
      await bind(serviceClient, config.bindDN, config.bindPassword);

      const filter = config.userSearchFilter.replace(
        /\{\{username\}\}/g,
        ldapEscapeFilter(username),
      );
      const entries = await search(
        serviceClient,
        config.userSearchBase,
        filter,
        [
          config.usernameAttribute || "uid",
          config.displayNameAttribute || "cn",
          "mail",
          "email",
          "distinguishedName",
        ],
      );
      if (entries.length === 0) throw await refuse("user not found");
      // Taking the first of several matches could sign in the wrong person.
      if (entries.length > 1) {
        throw await refuse(`search filter matched ${entries.length} entries`);
      }

      const userEntry = entries[0];
      // AD supplies its DN as an attribute; avoid re-serializing it through ldapjs.
      const userDN =
        firstValue(userEntry, "distinguishedName") || userEntry.dn.toString();
      const uid =
        firstValue(userEntry, config.usernameAttribute || "uid") || username;
      const displayName =
        firstValue(userEntry, config.displayNameAttribute || "cn") || username;
      const email =
        firstValue(userEntry, "mail") || firstValue(userEntry, "email") || "";

      const userClient = createClient(config, ctx.log);
      try {
        await bind(userClient, userDN, password);
      } catch {
        throw await refuse("wrong password");
      } finally {
        unbind(userClient);
      }

      let isAdmin: boolean | undefined;
      if (config.adminGroup && config.groupSearchBase) {
        isAdmin = false;
        try {
          const groups = await search(
            serviceClient,
            config.groupSearchBase,
            `(member=${ldapEscapeFilter(userDN)})`,
            ["cn", "dn"],
          );
          const wanted = normalizeDn(config.adminGroup);
          isAdmin = groups.some(
            (group) =>
              firstValue(group, "cn") === config.adminGroup ||
              normalizeDn(group.dn.toString()) === wanted,
          );
        } catch (error) {
          ctx.log.warn(`LDAP group check failed: ${String(error)}`);
        }
      }

      return {
        kind: "external",
        provider: identityProvider(providerId),
        subject: uid,
        email: email || null,
        name: displayName,
        isAdmin,
        allowedUsers: config.allowedUsers ?? null,
        legacy: {
          identifier: `ldap:${providerId}:${uid}`,
          providerRowId: providerId,
        },
        rememberMe: !!body.rememberMe,
        rateLimitKey,
      };
    } finally {
      unbind(serviceClient);
    }
  };
}
