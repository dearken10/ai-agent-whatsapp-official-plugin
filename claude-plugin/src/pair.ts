// Headless pairing helper: requests a pairing code from the routing backend,
// prints the wa.me link and code, then waits for the WS PAIRING_COMPLETE event
// so the user can confirm activation in the same terminal.
import WebSocket from "ws";
import { wsUrlFromHttpBase } from "./config.ts";

async function main(): Promise<void> {
  const baseUrl = process.env.ROUTING_BASE_URL ?? "http://localhost:28080";
  const response = await fetch(`${baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`pair request failed: ${response.status}`);
  const pair = (await response.json()) as {
    instanceId: string;
    pairingCode: string;
    waMeUrl: string;
    apiKey: string;
  };

  console.log("\n=== Pairing ===");
  console.log(`Open:    ${pair.waMeUrl}`);
  console.log(`Code:    ${pair.pairingCode}`);
  console.log(`apiKey:  ${pair.apiKey}`);
  console.log("Set ROUTING_API_KEY to the apiKey above before running `npm start`.\n");

  const ws = new WebSocket(wsUrlFromHttpBase(baseUrl), {
    headers: { Authorization: `Bearer ${pair.apiKey}` },
  });
  ws.on("message", (raw) => {
    const env = JSON.parse(String(raw)) as { type: string };
    console.log(`event: ${env.type}`);
    if (env.type === "PAIRING_COMPLETE") {
      console.log("Paired. Exiting.");
      ws.close();
      process.exit(0);
    }
  });
  ws.on("error", (err) => console.error(`ws error: ${String(err)}`));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
