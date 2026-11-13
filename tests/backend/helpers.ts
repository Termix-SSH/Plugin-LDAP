import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import { PluginCapabilityError } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";

export const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

export interface TestServer {
  db: TestDb;
  mock: MockPluginContext;
  request: (
    method: string,
    path: string,
    options?: {
      user?: string;
      body?: unknown;
      form?: Record<string, string>;
      headers?: Record<string, string>;
    },
    // Route bodies vary per test; asserting on them is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any; location: string | null }>;
  close: () => Promise<void>;
}

const realFetch = globalThis.fetch;

export async function startServer(
  options: {
    capabilities?: string[];
    permissions?: string[];
    linkedUsers?: Record<string, number>;
    loginAttemptLimit?: number;
    before?: (sqlite: TestDb["sqlite"]) => void;
  } = {},
): Promise<TestServer> {
  const db = await createTestDb(pluginDir, { before: options.before });
  db.sqlite
    .prepare("INSERT INTO users (id, username, is_admin) VALUES (?, ?, 1)")
    .run("admin", "admin");

  let router: Router | null = null;
  const capabilities = options.capabilities ?? manifest.capabilities;
  const mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: options.permissions,
    linkedUsers: options.linkedUsers,
    loginAttemptLimit: options.loginAttemptLimit,
  });
  // SDK 2.2.1's sandbox mock still refuses login methods; 2.2.2 takes them.
  // Drop this once the lock moves to 2.2.2.
  const auth = mock.ctx.auth as unknown as Record<string, unknown>;
  const registerLogin = auth.registerLoginMethod as (method: unknown) => void;
  auth.registerLoginMethod = (method: never) => {
    try {
      registerLogin(method);
    } catch (error) {
      if ((error as { code?: string }).code !== "SANDBOX_UNSUPPORTED") {
        throw error;
      }
      if (!capabilities.includes("auth:provide")) {
        throw new PluginCapabilityError(manifest.id, "auth:provide");
      }
      mock.auth.loginMethods.push(method);
    }
  };

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") || undefined);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    db,
    mock,
    async request(
      method,
      path,
      { user = "admin", body, form, headers = {} } = {},
    ) {
      const payload =
        form !== undefined
          ? new URLSearchParams(form).toString()
          : body !== undefined && method !== "GET"
            ? JSON.stringify(body)
            : undefined;
      const response = await realFetch(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: "manual",
        headers: {
          "x-test-user": user,
          ...(form !== undefined
            ? { "content-type": "application/x-www-form-urlencoded" }
            : payload !== undefined
              ? { "content-type": "application/json" }
              : {}),
          ...headers,
        },
        body: payload,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return {
        status: response.status,
        body: parsed,
        location: response.headers.get("location"),
      };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
