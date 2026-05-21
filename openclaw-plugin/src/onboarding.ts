import QRCode from "qrcode";
import type { ChannelOnboardingAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { CHANNEL_CONFIG_KEY } from "./constants.js";
import { requestPairingCode, resolveAccountFromCfg } from "./transport.js";

async function renderQr(url: string): Promise<string> {
  const qr = await QRCode.toString(url, { type: "utf8", small: true, margin: 2 });
  // Paint white background on every QR line so the quiet-zone border is visible
  // on dark terminals (without this, margin whitespace blends into terminal bg).
  const lines = qr.split("\n");
  const maxLen = Math.max(...lines.map((l) => l.length));
  const whiteBackground = lines
    .map((l) => `\x1b[47m\x1b[30m${l.padEnd(maxLen)}\x1b[0m`)
    .join("\n");
  // OSC 8 hyperlink so the URL is clickable in supported terminals
  const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
  return `${whiteBackground}\n${link}`;
}

export const whatsappOfficialOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: CHANNEL_CONFIG_KEY,

  getStatus: async ({ cfg }) => {
    const account = resolveAccountFromCfg(cfg as OpenClawConfig);
    return {
      channel: CHANNEL_CONFIG_KEY,
      configured: account.configured,
      statusLines: account.configured
        ? [`Paired — instance: ${account.instanceId}`]
        : ["Not configured — run: openclaw onboard"],
    };
  },

  configure: async ({ cfg, prompter }) => {
    await prompter.intro("Official WhatsApp API Setup — by imBee");

    await prompter.note(
      [
        "This plugin connects your OpenClaw agent to WhatsApp via imBee's",
        "verified WhatsApp Business Account — no Meta verification needed.",
        "",
        "FREE TIER  Your agent will use a shared imBee number.",
        "           Perfect for personal use and pilots.",
        "",
        "PAID PLAN  Get a dedicated number with your own brand identity.",
        "           Contact imBee at info@imbee.io or wa.me/85230013636 to upgrade.",
        "",
        "imBee is a transparent proxy — message content is never stored.",
      ].join("\n"),
      "How it works",
    );

    const existing = resolveAccountFromCfg(cfg as OpenClawConfig);
    const routingBaseUrl = await prompter.text({
      message: "Routing server base URL",
      initialValue: existing.routingBaseUrl,
      placeholder: "http://localhost:28080",
      validate: (v) => (v.trim() ? undefined : "Required"),
    });

    const progress = prompter.progress("Requesting pairing code…");
    progress.update("Requesting pairing code…");
    let pairResult: { instanceId: string; pairingCode: string; apiKey: string; waMeUrl: string };
    try {
      pairResult = await requestPairingCode(routingBaseUrl.trim());
      progress.stop("Pairing code issued");
    } catch (err) {
      progress.stop("Failed to contact routing server");
      throw err;
    }

    // Write the QR directly to stdout — prompter.note() runs its content through a
    // word-wrapper (wrapLine) that splits on whitespace and collapses multiple spaces,
    // which destroys the QR module spacing and renders it unscannable.
    const qrDisplay = await renderQr(pairResult.waMeUrl).catch(() => "");
    if (qrDisplay) process.stdout.write(`\n${qrDisplay}\n`);
    await prompter.note(
      `Scan the QR code above, or open this link:\n${pairResult.waMeUrl}\n\nEnter the pairing code when WhatsApp prompts:\n\n  ${pairResult.pairingCode}`,
      "Scan to Pair",
    );

    await prompter.confirm({
      message: "Have you entered the pairing code in WhatsApp?",
      initialValue: true,
    });

    const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
    const currentSection = (channels[CHANNEL_CONFIG_KEY] as Record<string, unknown> | undefined) ?? {};
    const newCfg = {
      ...(cfg as Record<string, unknown>),
      channels: {
        ...channels,
        [CHANNEL_CONFIG_KEY]: {
          ...currentSection,
          routingBaseUrl: routingBaseUrl.trim(),
          instanceId: pairResult.instanceId,
          apiKey: pairResult.apiKey,
        },
      },
    } as OpenClawConfig;

    await prompter.outro(
      "Paired! Restart the gateway to go live.\n\n" +
      "Need a dedicated number with your own brand?\n" +
      "→ https://wa.me/85230013636?text=I+need+a+dedicated+whatsapp+number+for+ai+agent",
    );
    return { cfg: newCfg };
  },
};
