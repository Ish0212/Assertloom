import { readFile } from "node:fs/promises";
import path from "path";
import axios from "axios";
import * as db from "./db";
import { PrismaClient } from "@prisma/client";
import type { User } from "./models";
import { type Config, loadConfig } from "./config";

export { formatDate } from "./dates";
export * from "./shared";

const prisma = new PrismaClient();

export async function readConfigFile(dir: string): Promise<string> {
  return readFile(path.join(dir, "config.json"), "utf8");
}

export async function getUser(id: string): Promise<User> {
  const { data } = await axios.get(`/users/${id}`);
  return data;
}

export async function saveUser(user: User): Promise<void> {
  await db.save("users", user);
}

export async function countUsers(): Promise<number> {
  return prisma.user.count();
}

export function getConfig(): Config {
  return loadConfig();
}

export function shout(path: string): string {
  return path.toUpperCase();
}

export async function loadColors() {
  const { default: chalk } = await import("chalk");
  return chalk;
}
