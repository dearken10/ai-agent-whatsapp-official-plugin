import QRCode from "qrcode";
import type { ChannelSetupWizardAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
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

export const whatsappOfficialOnboardingAdapter: ChannelSetupWizardAdapter = {
  channel: CHANNEL_CONFIG_KEY,

  getStatus: async ({ cfg }) => {
    const account = resolveAccountFromCfg(cfg as OpenClawConfig);
    return {
      channel: CHANNEL_CONFIG_KEY,
      configured: account.configured,
      statusLines: account.configured
        ? [`WhatsApp Official API by imBee: configured`]
        : ["WhatsApp Official API by imBee: not configured"],
    };
  },

  configure: async ({ cfg, prompter }) => {
    await prompter.intro("WhatsApp Official API Setup — by imBee");

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
      placeholder: "https://openclaw-plugin.dev.ent.imbee.io",
      validate: (v) => (v.trim() ? undefined : "Required"),
    });

    // Mode selector: Single-Use vs Persistent Invite
    const mode = await prompter.select<"single_use" | "persistent">({
      message: "Pairing mode",
      options: [
        {
          value: "single_use",
          label: "Single-Use (Recommended)",
          hint: "One QR code pairs exactly one phone — expires in 10 minutes",
        },
        {
          value: "persistent",
          label: "Persistent Invite",
          hint: "Reusable link — any phone that sends the code is paired to your agent; use dmPolicy: allowlist to restrict access",
        },
      ],
      initialValue: "single_use",
    });

    const progress = prompter.progress("Requesting pairing code…");
    progress.update("Requesting pairing code…");
    let pairResult: {
      mode: string;
      instanceId: string;
      pairingCode: string;
      apiKey: string;
      waMeUrl: string;
      expiresAt?: string;
      inviteId?: string;
    };
    try {
      pairResult = await requestPairingCode(routingBaseUrl.trim(), mode);
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

    if (mode === "persistent") {
      await prompter.note(
        [
          "This is a Persistent Invite — a reusable pairing link.",
          "",
          "Share the QR code or link above with anyone who should reach your agent.",
          "Every phone that sends the code will be paired automatically.",
          "",
          "Scan the QR code above, or open this link:",
          pairResult.waMeUrl,
          "",
          "⚠  IMPORTANT: Anyone with this link can pair and message your agent.",
          "   Set dmPolicy: allowlist in your config to restrict access.",
          "",
          "To revoke the invite later:",
          "  openclaw channels manage → revoke invite",
        ].join("\n"),
        "Persistent Invite — Share with your users",
      );
      // For persistent mode, don't wait for scan confirmation — the invite is already
      // live and can be scanned at any time.
    } else {
      await prompter.note(
        `Scan the QR code above, or open this link:\n${pairResult.waMeUrl}\n\nEnter the pairing code when WhatsApp prompts:\n\n  ${pairResult.pairingCode}`,
        "Scan to Pair",
      );

      await prompter.confirm({
        message: "Have you entered the pairing code in WhatsApp?",
        initialValue: true,
      });
    }

    const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
    const currentSection = (channels[CHANNEL_CONFIG_KEY] as Record<string, unknown> | undefined) ?? {};
    const newChannelSection: Record<string, unknown> = {
      ...currentSection,
      routingBaseUrl: routingBaseUrl.trim(),
      instanceId: pairResult.instanceId,
      apiKey: pairResult.apiKey,
    };
    if (pairResult.inviteId) {
      newChannelSection.inviteId = pairResult.inviteId;
    }
    const newCfg = {
      ...(cfg as Record<string, unknown>),
      channels: {
        ...channels,
        [CHANNEL_CONFIG_KEY]: newChannelSection,
      },
    } as OpenClawConfig;

    await prompter.note(
      [
        "By default any paired WhatsApp number can message your agent.",
        "To restrict access, add the following to your OpenClaw config:",
        "",
        "  channels:",
        `    ${CHANNEL_CONFIG_KEY}:`,
        "      dmPolicy: allowlist",
        "      allowFrom:",
        '        - "+1234567890"   # ← numbers you want to allow',
        '      dmDenyMessage: "Sorry, you are not authorised. Contact owner@example.com for access."',
        "",
        "Blocked senders receive dmDenyMessage automatically.",
        "Omit it to use the built-in default reply.",
        "",
        "⚠  This is especially important with a Persistent Invite code.",
        "   Anyone who receives the wa.me link can pair and reach your agent.",
        "   Lock it down with dmPolicy: allowlist once you know your users.",
        "",
        "Changes take effect after restarting the gateway — no re-pairing needed.",
      ].join("\n"),
      "Protect your agent (optional)",
    );

    await prompter.outro(
      "Paired! Restart the gateway to go live.\n\n" +
      "Need a dedicated number with your own brand?\n" +
      "→ https://wa.me/85230013636?text=I+need+a+dedicated+whatsapp+number+for+ai+agent",
    );
    return { cfg: newCfg };
  },
};
