/**
 * Prompts live in /prompts as versioned markdown files, one per node, so you
 * can diff and eval them independently of the graph code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "./artifacts";

const cache = new Map<string, string>();

/** Load `prompts/<name>.md`, e.g. loadPrompt("review/security"). */
export function loadPrompt(name: string): string {
  if (!cache.has(name)) cache.set(name, readFileSync(join(ENGINE_ROOT, "prompts", `${name}.md`), "utf8"));
  return cache.get(name)!;
}

/** Replace {{var}} placeholders. Unknown placeholders are left visible on purpose. */
export function render(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
}

/** The shared writing rules, for the project owner (walkthroughs) or for developers (repo docs and comments). */
export function writingRules(audience: "owner" | "developer"): string {
  return render(loadPrompt("_writing"), { audience: loadPrompt(`_audience-${audience}`).trim() });
}
