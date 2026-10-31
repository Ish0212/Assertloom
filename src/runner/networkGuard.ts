import { writeFile } from "node:fs/promises";
import path from "node:path";

export const NETWORK_BLOCKED_CODE = "ASSERTLOOM_NETWORK_BLOCKED";
export const NETWORK_BLOCKED_MESSAGE = "Assertloom blocked a network connection";

/**
 * Preloaded into Jest (and any Node subprocess it starts) with `--require`. It fails TCP connections
 * and DNS lookups, which covers `net`, `http`, `https`, `tls`, and `fetch`. Local pipes stay usable.
 */
const GUARD_SOURCE = `"use strict";
const net = require("node:net");
const dns = require("node:dns");

const blocked = (target) =>
  Object.assign(
    new Error(${JSON.stringify(NETWORK_BLOCKED_MESSAGE)} + " to " + target + ". Generated tests run offline: mock the dependency, or rerun with --allow-network."),
    { code: ${JSON.stringify(NETWORK_BLOCKED_CODE)} },
  );

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options === null || typeof options !== "object") options = { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
  if (options.path) return connect.apply(this, args);
  const error = blocked((options.host || "localhost") + ":" + options.port);
  process.nextTick(() => this.destroy(error));
  return this;
};

// Local servers resolve their own host before listening; connections are still blocked above.
const local = (host) => typeof host === "string" && (net.isIP(host) !== 0 || host === "localhost");
const guard = (original) =>
  function (...args) {
    if (local(args[0])) return original.apply(this, args);
    const error = blocked(String(args[0]));
    const callback = args[args.length - 1];
    if (typeof callback === "function") return void process.nextTick(callback, error);
    return Promise.reject(error);
  };
for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveSrv", "resolveTxt", "reverse"]) {
  if (typeof dns[name] === "function") dns[name] = guard(dns[name]);
  if (typeof dns.promises[name] === "function") dns.promises[name] = guard(dns.promises[name]);
}
`;

/** Writes the guard into `dir` and returns the NODE_OPTIONS fragment that preloads it. */
export async function writeNetworkGuard(dir: string): Promise<string> {
  const file = path.join(dir, "network-guard.cjs");
  await writeFile(file, GUARD_SOURCE);
  // NODE_OPTIONS drops backslashes inside quotes on Windows; Node accepts forward slashes everywhere.
  return `--require "${file.replaceAll("\\", "/")}"`;
}
