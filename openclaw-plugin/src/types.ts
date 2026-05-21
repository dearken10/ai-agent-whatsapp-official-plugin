import type { GroupPolicy } from "openclaw/plugin-sdk";

export type ResolvedWhatsappOfficialAccount = {
  accountId: string;
  configured: boolean;
  routingBaseUrl: string;
  instanceId: string;
  apiKey: string | null;
  inviteId?: string;
  allowFrom: string[];
  dmDenyMessage: string;
  defaultTo?: string;
  dmPolicy: string;
  groupPolicy: GroupPolicy;
};
