/** Helpers that more than one review node uses. */
import { SEVERITIES, type Severity, type Verification } from "@flows/core";

/** Where a severity sits on the scale, from 0 for `nit` up to `blocker`. */
export const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** A finding the verifier couldn't check goes on to triage as before, rather than being dropped. */
export const UNCHECKED = (why: string): Verification => ({ verdict: "valid", evidence: `Not verified: ${why}`, checked: false });

/** Just the part of the diff for one file — the judge doesn't need the rest. */
export function fileDiff(diff: string, file?: string, limit = 4000): string {
  if (!file) return diff.slice(0, limit);
  const parts = diff.split(/^(?=diff --git )/m);
  return (parts.find((p) => p.includes(`b/${file}`)) ?? diff).slice(0, limit);
}
