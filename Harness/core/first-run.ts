/**
 * First-run and doctor next actions. Four steps, no lecture.
 * install/open → provider → key or /login → one model → loop.
 */
import { isProviderSelectionRequired, type ProviderProfile } from "./provider-profile.js";
import { missingKeyNextAction, type ManagedKeyName } from "./key-catalog.js";

export const FIRST_RUN_STEPS = [
  "llp provider select PRESET",
  "printf %s \"$KEY\" | llp key set NAME   or   llp auth then /login",
  "llp provider models   then   llp provider pick N",
  "llp loop \"your goal\"",
] as const;

export function firstRunMessage(): string {
  return [
    "LightningLoop first run: choose a provider before opening the TUI.",
    `Next: ${FIRST_RUN_STEPS[0]}`,
    `Then: ${FIRST_RUN_STEPS[1]}`,
    `Then: ${FIRST_RUN_STEPS[2]}`,
    `Then: ${FIRST_RUN_STEPS[3]}`,
  ].join("\n");
}

export function doctorNextAction(input: {
  selectionRequired: boolean;
  piManaged: boolean;
  managedKeyReady: boolean;
  managedKeyName?: ManagedKeyName;
}): string {
  if (input.selectionRequired) return `Next: ${FIRST_RUN_STEPS[0]}`;
  if (input.piManaged) return "Next: llp auth then /login  (skip if already signed in, then llp loop \"your goal\")";
  if (!input.managedKeyReady) {
    return `Next: ${missingKeyNextAction(input.managedKeyName ?? "openrouter")}`;
  }
  return `Next: ${FIRST_RUN_STEPS[3]}`;
}

export function firstRunBlocked(profile: ProviderProfile): boolean {
  return isProviderSelectionRequired(profile);
}
