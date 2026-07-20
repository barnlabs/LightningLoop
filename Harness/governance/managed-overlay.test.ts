import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedOverlay } from "./managed-overlay.js";

test("rotates bounded backups and restores without losing the pre-restore state", () => {
  const overlay = new ManagedOverlay(mkdtempSync(join(tmpdir(), "lightningloop-overlay-")));
  overlay.initialize();
  const skill = join(overlay.current, "skills", "example.md");
  writeFileSync(skill, "v1");
  overlay.backup();
  writeFileSync(skill, "v2");
  overlay.restore(0);
  assert.equal(readFileSync(skill, "utf8"), "v1");
  assert.equal(overlay.status().backups[0]?.snapshot?.files.some((file) => file.sha256.length === 64), true);
});

test("managed skills install disabled and can be explicitly enabled and disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: careful-review\ndescription: Bounded review.\n---\n\n# Careful review\n");
  mkdirSync(join(source, "references"));
  writeFileSync(join(source, "references", "proof.md"), "proof contract");
  const overlay = new ManagedOverlay(root);
  assert.throws(() => overlay.installSkill(source, "yes"), /exact/);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  assert.equal(installed.enabled, false);
  assert.throws(() => overlay.setSkillEnabled("careful-review", true), /explicit approval/);
  assert.equal(overlay.setSkillEnabled("careful-review", true, installed.sha256).enabled, true);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "careful-review", "SKILL.md")), true);
  assert.equal(overlay.setSkillEnabled("careful-review", false).enabled, false);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "careful-review")), false);
});

test("managed skill activation rejects drift after reviewed installation", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: reviewed-skill\ndescription: Reviewed.\n---\n\n# Original\n");
  const overlay = new ManagedOverlay(root);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  writeFileSync(join(overlay.current, "skills", "reviewed-skill", "SKILL.md"), "---\nname: reviewed-skill\ndescription: Changed.\n---\n\n# Changed\n");
  assert.throws(() => overlay.setSkillEnabled("reviewed-skill", true, installed.sha256), /changed after installation review/);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "reviewed-skill")), false);
});

test("post-copy validation failure never exposes an unapproved active tree", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: atomic-enable\ndescription: Reviewed.\n---\n\n# Original\n");
  const overlay = new ManagedOverlay(root);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  const runtime = overlay as unknown as { treeHash(directory: string): string };
  const originalTreeHash = runtime.treeHash.bind(overlay);
  let calls = 0;
  runtime.treeHash = (directory: string) => {
    calls += 1;
    return calls === 2 ? "0".repeat(64) : originalTreeHash(directory);
  };

  assert.throws(() => overlay.setSkillEnabled("atomic-enable", true, installed.sha256), /changed while staging/);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "atomic-enable")), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith(".enable-atomic-enable-")), false);
});

test("post-commit bookkeeping failure restores the previously approved active tree", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: rollback-enable\ndescription: Reviewed.\n---\n\n# Version one\n");
  const overlay = new ManagedOverlay(root);
  const first = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  overlay.setSkillEnabled("rollback-enable", true, first.sha256);
  const active = join(overlay.current, "enabled-skills", "rollback-enable", "SKILL.md");
  const previous = readFileSync(active, "utf8");

  writeFileSync(join(overlay.current, "skills", "rollback-enable", "SKILL.md"), "---\nname: rollback-enable\ndescription: Reviewed.\n---\n\n# Version two\n");
  const runtime = overlay as unknown as {
    treeHash(directory: string): string;
    writeSnapshot(directory: string): void;
  };
  const nextHash = runtime.treeHash(join(overlay.current, "skills", "rollback-enable"));
  writeFileSync(join(overlay.skillRecords, "rollback-enable.json"), `${JSON.stringify({ schemaVersion: 1, id: "rollback-enable", installedHash: nextHash })}\n`);
  const originalWriteSnapshot = runtime.writeSnapshot.bind(overlay);
  let fail = true;
  runtime.writeSnapshot = (directory: string) => {
    if (fail && directory === overlay.current && readFileSync(active, "utf8").includes("Version two")) {
      fail = false;
      throw new Error("synthetic post-commit snapshot failure");
    }
    originalWriteSnapshot(directory);
  };

  assert.throws(() => overlay.setSkillEnabled("rollback-enable", true, nextHash), /synthetic post-commit/);
  assert.equal(readFileSync(active, "utf8"), previous);
  assert.equal(readdirSync(root).some((name) => name.startsWith(".enable-rollback-enable-") || name.startsWith(".retired-enabled-rollback-enable-")), false);
});

test("post-commit bookkeeping failure leaves no active tree when enable replaced none", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: rollback-empty\ndescription: Reviewed.\n---\n\n# Candidate\n");
  const overlay = new ManagedOverlay(root);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  const active = join(overlay.current, "enabled-skills", "rollback-empty");
  const runtime = overlay as unknown as { writeSnapshot(directory: string): void };
  const originalWriteSnapshot = runtime.writeSnapshot.bind(overlay);
  let fail = true;
  runtime.writeSnapshot = (directory: string) => {
    if (fail && directory === overlay.current && existsSync(active)) {
      fail = false;
      throw new Error("synthetic empty-active bookkeeping failure");
    }
    originalWriteSnapshot(directory);
  };

  assert.throws(() => overlay.setSkillEnabled("rollback-empty", true, installed.sha256), /synthetic empty-active/);
  assert.equal(existsSync(active), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith(".enable-rollback-empty-") || name.startsWith(".retired-enabled-rollback-empty-")), false);
});

test("managed skill deactivation succeeds even when the inactive installation drifted", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: fail-safe-disable\ndescription: Reviewed.\n---\n\n# Original\n");
  const overlay = new ManagedOverlay(root);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  assert.equal(overlay.setSkillEnabled("fail-safe-disable", true, installed.sha256).enabled, true);
  writeFileSync(join(overlay.current, "skills", "fail-safe-disable", "SKILL.md"), "---\nname: fail-safe-disable\ndescription: Drifted inactive copy.\n---\n\n# Drifted\n");

  assert.equal(overlay.setSkillEnabled("fail-safe-disable", false).enabled, false);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "fail-safe-disable")), false);
  assert.throws(() => overlay.setSkillEnabled("fail-safe-disable", true, installed.sha256), /changed after installation review/);
});

test("secret-shaped inactive drift cannot block deactivation", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: secret-drift\ndescription: Reviewed.\n---\n\n# Original\n");
  const overlay = new ManagedOverlay(root);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  overlay.setSkillEnabled("secret-drift", true, installed.sha256);
  writeFileSync(join(overlay.current, "skills", "secret-drift", "SKILL.md"), "api_key=synthetic_secret_value_12345");

  assert.equal(overlay.setSkillEnabled("secret-drift", false).enabled, false);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "secret-drift")), false);
  assert.equal(existsSync(join(overlay.deactivationBackups, "slot-0", "SKILL.md")), true);
});

test("symlink drift in the inactive copy cannot block deactivation", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const source = mkdtempSync(join(tmpdir(), "lightningloop-skill-"));
  writeFileSync(join(source, "SKILL.md"), "---\nname: symlink-drift\ndescription: Reviewed.\n---\n\n# Original\n");
  const overlay = new ManagedOverlay(root);
  const installed = overlay.installSkill(source, "INSTALL-MANAGED-SKILL");
  overlay.setSkillEnabled("symlink-drift", true, installed.sha256);
  const inactiveSkill = join(overlay.current, "skills", "symlink-drift", "SKILL.md");
  rmSync(inactiveSkill);
  symlinkSync("/tmp", inactiveSkill);

  assert.equal(overlay.setSkillEnabled("symlink-drift", false).enabled, false);
  assert.equal(existsSync(join(overlay.current, "enabled-skills", "symlink-drift")), false);
});

test("reset is explicit and symlinks fail closed", () => {
  const overlay = new ManagedOverlay(mkdtempSync(join(tmpdir(), "lightningloop-overlay-")));
  overlay.initialize();
  assert.throws(() => overlay.reset("yes"), /exact/);
  symlinkSync("/tmp", join(overlay.current, "skills", "escape"));
  assert.throws(() => overlay.status(), /symbolic links/);
});

test("status is read-only and backup restore rejects secrets and tampering", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-overlay-"));
  const overlay = new ManagedOverlay(root);
  assert.equal(existsSync(overlay.current), false);
  assert.equal(overlay.status().current.files.length, 0);
  assert.equal(existsSync(overlay.current), false);

  overlay.initialize();
  const skill = join(overlay.current, "skills", "example.md");
  writeFileSync(skill, "reviewed");
  overlay.backup();
  const snapshotPath = join(overlay.backups, "slot-0", "snapshot.json");
  const modifiedBefore = statSync(snapshotPath).mtimeMs;
  overlay.status();
  assert.equal(statSync(snapshotPath).mtimeMs, modifiedBefore);
  writeFileSync(join(overlay.backups, "slot-0", "skills", "example.md"), "tampered");
  assert.throws(() => overlay.restore(0), /integrity/);
  writeFileSync(skill, "api_key=synthetic_secret_value_12345");
  assert.throws(() => overlay.status(), /secret-shaped/);
});
