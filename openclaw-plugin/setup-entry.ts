import { whatsappOfficialPlugin } from "./src/channel.js";

// setup-entry.ts is loaded by openclaw's guided setup wizard (channels add).
// It must export { plugin } directly — NOT the gateway plugin registration format
// ({ id, register() }) used by index.ts. The loader calls resolveSetupChannelRegistration
// which checks `export.default.plugin`; if missing, it returns {} and the wizard
// shows "does not support guided setup yet".
export default {
  plugin: whatsappOfficialPlugin,
};
