import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("registers only the directory settings; Termix draws the sign in form", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.loginMethods()).toEqual([]);
    expect(rendered.registered.settingsComponents()).toEqual(["providers"]);
  });

  it("lists directories without their bind password", async () => {
    const get = vi.fn(async () => ({
      data: {
        providers: [
          {
            id: 4,
            name: "Corp LDAP",
            enabled: true,
            displayOrder: 0,
            config: { host: "ldap.example" },
            hasBindPassword: true,
          },
        ],
      },
    }));
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get } as never,
    });
    rendered.renderSettingsComponent("providers");
    expect(await screen.findByText("Corp LDAP")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("/providers");
  });

  it("sends a cleared admin group so it is cleared on the server", async () => {
    const get = vi.fn(async () => ({
      data: {
        providers: [
          {
            id: 4,
            name: "Corp LDAP",
            enabled: true,
            displayOrder: 0,
            config: { host: "ldap.example", adminGroup: "admins" },
            hasBindPassword: true,
          },
        ],
      },
    }));
    const put = vi.fn(async () => ({ data: {} }));
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get, put } as never,
    });
    rendered.renderSettingsComponent("providers");
    fireEvent.click(await screen.findByTitle(locales.providers.edit));
    fireEvent.change(await screen.findByDisplayValue("admins"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByText(locales.providers.save));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0] as unknown as [
      string,
      { config: Record<string, unknown> },
    ];
    expect(path).toBe("/providers/4");
    expect(body.config.adminGroup).toBe("");
    expect(body.config).not.toHaveProperty("bindPassword");
  });

  it("removes everything on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.settingsComponents()).toEqual([]);
  });
});
