import type { GroupPolicy } from "openclaw/plugin-sdk";

export type ResolvedWhatsappOfficialAccount = {
  accountId: string;
  configured: boolean;
  routingBaseUrl: string;
  instanceId: string;
  apiKey: string | null;
  allowFrom: string[];
  defaultTo?: string;
  dmPolicy: string;
  groupPolicy: GroupPolicy;
};
