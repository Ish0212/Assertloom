#!/usr/bin/env node
/**
 * Records a real terminal session as an asciinema v2 file (https://docs.asciinema.org/manual/asciicast/v2/).
 *
 *   node scripts/record-demo.mjs --out docs/demo.cast --cwd <dir> --show "npx assertloom generate src/rates.js" -- node dist/cli/index.js generate src/rates.js
 *
 * `--show` is the command displayed at the prompt; everything after `--` is what actually runs.
 * Pauses longer than --max-idle seconds (model calls, Jest startup) are shortened for viewing.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const split = process.argv.indexOf("--");
const { values } = parseArgs({
  args: process.argv.slice(2, split),
  options: {
    out: { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    show: { type: "string" },
    width: { type: "string", default: "100" },
    height: { type: "string", default: "24" },
    "max-idle": { type: "string", default: "2" },
  },
});
const [command, ...args] = process.argv.slice(split + 1);
if (split < 0 || !command || !values.out) throw new Error("Usage: record-demo.mjs --out <file> [--cwd dir] [--show text] -- <command...>");

const maxIdle = Number(values["max-idle"]);
const events = [];
let clock = 0;
let last = Date.now();
const emit = (text, delay) => {
  const now = Date.now();
  clock += delay ?? Math.min((now - last) / 1000, maxIdle);
  last = now;
  events.push([Number(clock.toFixed(3)), "o", text]);
};

emit("\u001b[32m$\u001b[0m ", 0.3);
for (const ch of values.show ?? [command, ...args].join(" ")) emit(ch, 0.04);
emit("\r\n", 0.4);
last = Date.now();

const child = spawn(command, args, { cwd: values.cwd });
const onData = (chunk) => emit(chunk.replace(/(?<!\r)\n/g, "\r\n"));
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", onData);
child.stderr.on("data", onData);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
emit("\u001b[32m$\u001b[0m ", 0.5);
emit("", 2.5);

const header = { version: 2, width: Number(values.width), height: Number(values.height), timestamp: Math.floor(Date.now() / 1000), title: values.show };
await writeFile(values.out, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`Recorded ${events.length} events (${clock.toFixed(1)}s, exit code ${code}) to ${values.out}`);
