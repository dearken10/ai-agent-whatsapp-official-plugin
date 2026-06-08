#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const scripts = {
  start: "index.ts",
  setup: "setup.ts",
  pair: "pair.ts",
};

const cmd = process.argv[2] ?? "start";
const script = scripts[cmd];
if (!script) {
  console.error(
    `Unknown command: ${cmd}\nUsage: claude-whatsapp-official-plugin <start|setup|pair>`,
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "--env-file-if-exists=.env",
    join(srcDir, script),
    ...process.argv.slice(3),
  ],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
