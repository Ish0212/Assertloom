import type { FunctionInfo } from "../types/index.js";

/** Renders a function like `async fetchJson<T>(url: string, init?: RequestInit): Promise<T>`. */
export function formatSignature(fn: FunctionInfo, name = fn.name): string {
  const params = fn.parameters
    .map((p) => {
      const optionalMark = p.optional && !p.rest && !p.defaultValue ? "?" : "";
      const type = p.type ? `: ${p.type}` : "";
      const defaultValue = p.defaultValue ? ` = ${p.defaultValue}` : "";
      return `${p.rest ? "..." : ""}${p.name}${optionalMark}${type}${defaultValue}`;
    })
    .join(", ");
  const prefix = `${fn.async ? "async " : ""}${fn.generator ? "*" : ""}`;
  return `${prefix}${name}${fn.typeParameters ?? ""}(${params})${fn.returnType ? `: ${fn.returnType}` : ""}`;
}
