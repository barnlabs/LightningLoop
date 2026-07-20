import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface PlatformPathEnvironment {
  LIGHTNINGLOOP_DATA_DIR?: string;
  APPDATA?: string;
  XDG_DATA_HOME?: string;
}

/**
 * Returns LightningLoop's own data root. This deliberately never points at
 * Pi's ~/.pi directory: Pi owns its authentication, packages, and settings.
 */
export function lightningLoopDataDirectory(
  platform = process.platform,
  env: PlatformPathEnvironment = process.env as unknown as PlatformPathEnvironment,
  home = homedir(),
): string {
  const override = env.LIGHTNINGLOOP_DATA_DIR?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error("LIGHTNINGLOOP_DATA_DIR must be absolute.");
    return override;
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "LightningLoop");
  if (platform === "win32") return join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "LightningLoop");
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "lightningloop");
}

export function lightningLoopDataPath(...segments: string[]): string {
  return join(lightningLoopDataDirectory(), ...segments);
}
