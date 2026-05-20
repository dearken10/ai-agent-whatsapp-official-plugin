import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PLUGIN_ID } from "./src/constants.js";
import { whatsappOfficialPlugin } from "./src/channel.js";
import { setWhatsappOfficialRuntime } from "./src/runtime.js";

export default {
  id: PLUGIN_ID,
  name: "Official WhatsApp API (imBee)",
  description: "Connect OpenClaw to WhatsApp through the imBee managed Cloud API channel.",
  register(api: OpenClawPluginApi) {
    setWhatsappOfficialRuntime(api.runtime);
    api.registerChannel({ plugin: whatsappOfficialPlugin });
  },
};
