import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWhatsappOfficialRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getWhatsappOfficialRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WhatsApp Official runtime not initialized");
  }
  return runtime;
}
