/**
 * Node refuses to strip TypeScript inside node_modules. peanut is published
 * as TypeScript (`github:neil-sriv/peanut#<sha>`), so this hook strips those
 * files before they run. A file: checkout outside node_modules does not need
 * it; the github pin does.
 */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

export async function load(url, context, nextLoad) {
  if (!url.includes("/node_modules/peanut/") || !url.endsWith(".ts")) return nextLoad(url, context);
  const source = stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip" });
  return { format: "module", source, shortCircuit: true };
}
