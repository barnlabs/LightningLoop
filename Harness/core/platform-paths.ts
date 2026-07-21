import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

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
  const platformPath = platform === "win32" ? win32 : posix;
  const override = env.LIGHTNINGLOOP_DATA_DIR?.trim();
  if (override) {
    if (!platformPath.isAbsolute(override)) throw new Error("LIGHTNINGLOOP_DATA_DIR must be absolute.");
    return override;
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "LightningLoop");
  if (platform === "win32") return win32.join(env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming"), "LightningLoop");
  return posix.join(env.XDG_DATA_HOME?.trim() || posix.join(home, ".local", "share"), "lightningloop");
}

export function lightningLoopDataPath(...segments: string[]): string {
  return join(lightningLoopDataDirectory(), ...segments);
}
