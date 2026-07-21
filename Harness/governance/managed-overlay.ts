import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { lightningLoopDataPath } from "../core/platform-paths.js";

const CATEGORIES = ["skills", "enabled-skills", "mcps", "tools", "graphs", "system-prompts"] as const;
const MAX_FILES = 2_048;
const MAX_BYTES = 64 * 1_024 * 1_024;
const BACKUP_SLOTS = 3;
const SECRET_SHAPE = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu;

export interface OverlayFileEvidence { path: string; bytes: number; sha256: string }
export interface OverlaySnapshot { createdAt: string; files: OverlayFileEvidence[]; totalBytes: number }
export interface OverlayStatus { root: string; current: OverlaySnapshot; backups: Array<{ slot: number; snapshot?: OverlaySnapshot }> }
export interface ManagedSkillStatus { id: string; enabled: boolean; sha256: string }

export class ManagedOverlay {
  readonly root: string;
  readonly current: string;
  readonly backups: string;
  readonly skillRecords: string;
  readonly deactivationBackups: string;

  constructor(root = lightningLoopDataPath("managed")) {
    this.root = resolve(root);
    this.current = join(this.root, "current");
    this.backups = join(this.root, "backups");
    this.skillRecords = join(this.root, "skill-installations");
    this.deactivationBackups = join(this.root, "skill-deactivation-backups");
  }

  initialize(): void {
    mkdirSync(this.current, { recursive: true, mode: 0o700 });
    mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    mkdirSync(this.skillRecords, { recursive: true, mode: 0o700 });
    for (const category of CATEGORIES) mkdirSync(join(this.current, category), { recursive: true, mode: 0o700 });
    this.writeSnapshot(this.current);
  }

  status(): OverlayStatus {
    return {
      root: this.root,
      current: existsSync(this.current) ? this.inspect(this.current) : { createdAt: new Date(0).toISOString(), files: [], totalBytes: 0 },
      backups: Array.from({ length: BACKUP_SLOTS }, (_, slot) => {
        const path = this.slotPath(slot);
        return { slot, ...(existsSync(path) ? { snapshot: this.inspect(path) } : {}) };
      }),
    };
  }

  backup(): OverlaySnapshot {
    this.initialize();
    const staged = join(this.root, `.backup-${randomUUID()}`);
    cpSync(this.current, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const snapshot = this.inspect(staged);
    this.writeSnapshot(staged, snapshot);
    rmSync(this.slotPath(BACKUP_SLOTS - 1), { recursive: true, force: true });
    for (let slot = BACKUP_SLOTS - 2; slot >= 0; slot -= 1) {
      const from = this.slotPath(slot);
      if (existsSync(from)) renameSync(from, this.slotPath(slot + 1));
    }
    renameSync(staged, this.slotPath(0));
    return snapshot;
  }

  restore(slot = 0): OverlaySnapshot {
    this.requireSlot(slot);
    this.initialize();
    const source = this.slotPath(slot);
    if (!existsSync(source)) throw new Error(`Managed-overlay backup slot ${slot} is empty.`);
    this.validateStoredSnapshot(source);
    const staged = join(this.root, `.restore-${randomUUID()}`);
    cpSync(source, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const desired = this.inspect(staged);
    this.backup();
    const retired = join(this.root, `.retired-${randomUUID()}`);
    renameSync(this.current, retired);
    try {
      renameSync(staged, this.current);
      rmSync(retired, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(this.current) && existsSync(retired)) renameSync(retired, this.current);
      throw error;
    }
    return desired;
  }

  reset(approval: string): OverlaySnapshot {
    if (approval !== "RESET-MANAGED-OVERLAY") throw new Error("Reset requires the exact RESET-MANAGED-OVERLAY approval token.");
    const snapshot = this.backup();
    const retired = join(this.root, `.reset-${randomUUID()}`);
    renameSync(this.current, retired);
    try {
      this.initialize();
      rmSync(retired, { recursive: true, force: true });
    } catch (error) {
      rmSync(this.current, { recursive: true, force: true });
      renameSync(retired, this.current);
      throw error;
    }
    return snapshot;
  }

  listSkills(): ManagedSkillStatus[] {
    if (!existsSync(this.current)) return [];
    const installedRoot = join(this.current, "skills");
    const enabledRoot = join(this.current, "enabled-skills");
    return readdirSync(installedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const skillFile = join(installedRoot, entry.name, "SKILL.md");
        if (!existsSync(skillFile)) throw new Error(`Managed skill ${entry.name} is missing SKILL.md.`);
        return {
          id: entry.name,
          enabled: existsSync(join(enabledRoot, entry.name, "SKILL.md")),
          sha256: this.treeHash(join(installedRoot, entry.name)),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  installSkill(source: string, approval: string): ManagedSkillStatus {
    if (approval !== "INSTALL-MANAGED-SKILL") throw new Error("Skill import requires the exact INSTALL-MANAGED-SKILL approval token.");
    this.initialize();
    const sourceRoot = resolve(source);
    const info = lstatSync(sourceRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Managed skill source must be a real directory.");
    const skillPath = join(sourceRoot, "SKILL.md");
    if (!existsSync(skillPath)) throw new Error("Managed skill source must contain SKILL.md.");
    const text = readFileSync(skillPath, "utf8");
    const id = /^---\s*[\s\S]*?^name:\s*([a-z][a-z0-9-]{0,63})\s*$/mu.exec(text)?.[1];
    if (!id) throw new Error("Managed SKILL.md must declare a safe frontmatter name.");
    const destination = join(this.current, "skills", id);
    if (existsSync(destination)) throw new Error(`Managed skill ${id} is already installed.`);
    this.backup();
    const staged = join(this.root, `.skill-${randomUUID()}`);
    cpSync(sourceRoot, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    this.inspect(staged);
    renameSync(staged, destination);
    const installedHash = this.treeHash(destination);
    writeFileSync(join(this.skillRecords, `${id}.json`), `${JSON.stringify({ schemaVersion: 1, id, installedHash, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    this.writeSnapshot(this.current);
    return this.listSkills().find((skill) => skill.id === id)!;
  }

  setSkillEnabled(id: string, enabled: boolean, approvedHash = ""): ManagedSkillStatus {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) throw new Error("Managed skill ID is invalid.");
    const installed = join(this.current, "skills", id);
    const active = join(this.current, "enabled-skills", id);
    if (!enabled) {
      // Deactivation is fail-safe: a damaged or drifted inactive installation
      // must never keep a previously reviewed active copy running.
      this.quarantineActiveSkill(id, active);
      try { this.writeSnapshot(this.current); } catch { /* Deactivation already succeeded; status repair can occur separately. */ }
      const recordPath = join(this.skillRecords, `${id}.json`);
      let installedHash = "unavailable";
      try {
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as { installedHash?: unknown };
        if (typeof record.installedHash === "string" && /^[a-f0-9]{64}$/u.test(record.installedHash)) installedHash = record.installedHash;
      } catch { /* A malformed record cannot prevent deactivation. */ }
      return { id, enabled: false, sha256: installedHash };
    }
    this.initialize();
    if (!existsSync(join(installed, "SKILL.md"))) throw new Error(`Managed skill ${id} is not installed.`);
    const recordPath = join(this.skillRecords, `${id}.json`);
    if (!existsSync(recordPath)) throw new Error(`Managed skill ${id} has no immutable installation record.`);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { schemaVersion?: unknown; id?: unknown; installedHash?: unknown };
    if (record.schemaVersion !== 1 || record.id !== id || typeof record.installedHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.installedHash)) {
      throw new Error(`Managed skill ${id} installation record is malformed.`);
    }
    const actualHash = this.treeHash(installed);
    if (actualHash !== record.installedHash) throw new Error(`Managed skill ${id} changed after installation review; enable is blocked.`);
    if (approvedHash !== actualHash) throw new Error(`Enabling ${id} requires explicit approval tied to reviewed hash ${actualHash}.`);
    const staged = join(this.root, `.enable-${id}-${randomUUID()}`);
    const retired = join(this.root, `.retired-enabled-${id}-${randomUUID()}`);
    let installedNewActive = false;
    let completed = false;
    try {
      cpSync(installed, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      this.inspect(staged);
      if (this.treeHash(staged) !== actualHash) throw new Error(`Managed skill ${id} changed while staging for activation.`);
      this.backup();
      if (existsSync(active)) renameSync(active, retired);
      try {
        renameSync(staged, active);
        installedNewActive = true;
      } catch (error) {
        if (!existsSync(active) && existsSync(retired)) renameSync(retired, active);
        throw error;
      }
      if (this.treeHash(active) !== actualHash) {
        throw new Error(`Managed skill ${id} failed its activation hash check.`);
      }
      this.writeSnapshot(this.current);
      const status = this.listSkills().find((skill) => skill.id === id);
      if (!status?.enabled || status.sha256 !== actualHash) throw new Error(`Managed skill ${id} failed its committed status check.`);
      completed = true;
      rmSync(retired, { recursive: true, force: true });
      return status;
    } catch (error) {
      if (installedNewActive && existsSync(active)) rmSync(active, { recursive: true, force: true });
      if (existsSync(retired) && !existsSync(active)) renameSync(retired, active);
      throw error;
    } finally {
      rmSync(staged, { recursive: true, force: true });
      if (!completed && !existsSync(active) && existsSync(retired)) renameSync(retired, active);
      if (completed || existsSync(active)) rmSync(retired, { recursive: true, force: true });
    }
  }

  private treeHash(directory: string): string {
    const snapshot = this.inspect(directory);
    return createHash("sha256").update(JSON.stringify(snapshot.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))).digest("hex");
  }

  private quarantineActiveSkill(id: string, active: string): void {
    if (!existsSync(active)) return;
    mkdirSync(this.deactivationBackups, { recursive: true, mode: 0o700 });
    const staged = join(this.deactivationBackups, `.deactivated-${id}-${randomUUID()}`);
    renameSync(active, staged);
    if (existsSync(active)) throw new Error(`Managed skill ${id} could not be disabled.`);
    // Rotation is best-effort after the atomic kill switch. A damaged backup
    // must never reactivate or keep the staging path present.
    try {
      rmSync(join(this.deactivationBackups, `slot-${BACKUP_SLOTS - 1}`), { recursive: true, force: true });
      for (let slot = BACKUP_SLOTS - 2; slot >= 0; slot -= 1) {
        const from = join(this.deactivationBackups, `slot-${slot}`);
        if (existsSync(from)) renameSync(from, join(this.deactivationBackups, `slot-${slot + 1}`));
      }
      renameSync(staged, join(this.deactivationBackups, "slot-0"));
    } catch {
      // `staged` remains outside enabled-skills as a recoverable quarantine.
    }
  }

  private inspect(directory: string): OverlaySnapshot {
    const files: OverlayFileEvidence[] = [];
    let totalBytes = 0;
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) throw new Error(`Managed overlay rejects symbolic links: ${relative(directory, path)}`);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!entry.isFile()) throw new Error(`Managed overlay rejects special files: ${relative(directory, path)}`);
        if (entry.name === "snapshot.json") continue;
        totalBytes += metadata.size;
        if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) throw new Error("Managed overlay exceeds its 2,048-file or 64-MiB bound.");
        const bytes = readFileSync(path);
        if (bytes.includes(0) || (bytes.length <= 1_048_576 && SECRET_SHAPE.test(bytes.toString("utf8")))) {
          throw new Error(`Managed overlay rejects secret-shaped content: ${relative(directory, path)}`);
        }
        files.push({ path: relative(directory, path).split(sep).join("/"), bytes: metadata.size, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    };
    walk(directory);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { createdAt: new Date().toISOString(), files, totalBytes };
  }

  private writeSnapshot(directory: string, snapshot = this.inspect(directory)): void {
    const path = join(directory, "snapshot.json");
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private validateStoredSnapshot(directory: string): void {
    const path = join(directory, "snapshot.json");
    if (!existsSync(path)) throw new Error("Managed-overlay backup has no integrity snapshot.");
    let stored: OverlaySnapshot;
    try { stored = JSON.parse(readFileSync(path, "utf8")) as OverlaySnapshot; }
    catch { throw new Error("Managed-overlay backup snapshot is malformed."); }
    const actual = this.inspect(directory);
    const expectedFiles = JSON.stringify(stored.files);
    const actualFiles = JSON.stringify(actual.files);
    if (stored.totalBytes !== actual.totalBytes || expectedFiles !== actualFiles) {
      throw new Error("Managed-overlay backup failed its recorded path, size, or hash integrity check.");
    }
  }

  private slotPath(slot: number): string { return join(this.backups, `slot-${slot}`); }
  private requireSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= BACKUP_SLOTS) throw new Error(`Backup slot must be 0-${BACKUP_SLOTS - 1}.`);
  }
}
