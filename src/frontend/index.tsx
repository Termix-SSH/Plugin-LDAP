import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { ProvidersSetting } from "./ProvidersSetting";

export function activate(app: TermixApp): void {
  app.registerSettingsComponent("providers", ProvidersSetting);
}
