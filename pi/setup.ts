import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

// Immutable source: the Python app is not yet published to PyPI.
export const cliSource = "https://github.com/kvidzibo/pinote/archive/9c6795f655e6b9d2c51c735fc84b6485fb663bb1.tar.gz";
export const setupHint = "Run /pi-note-setup in interactive Pi; note must be on PATH.";
export function compatibleVersion(version: string): boolean {
  const match = /^pinote (\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 3);
}
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 1500);

export async function setupCLI(
  pi: ExtensionAPI, ctx: ExtensionContext, upgrade: boolean,
  canAct: () => boolean, signal: AbortSignal,
): Promise<void> {
  const exec = (command: string, args: string[], timeout = 5000) =>
    pi.exec(command, args, { timeout, signal });
  if (!upgrade) {
    try {
      const current = await exec("note", ["--version"]);
      if (!current.killed && current.code === 0 && compatibleVersion(current.stdout)) {
        if (canAct()) ctx.ui.notify(`${clean(current.stdout.trim())} is ready. Use /pi-note. To reinstall the bundled CLI, use /pi-note-setup --upgrade.`, "info");
        return;
      }
    } catch { /* Missing CLI: offer installation, never send task commands. */ }
  }
  if (!canAct() || signal.aborted) return;
  try {
    const uv = await exec("uv", ["--version"]);
    if (uv.killed || uv.code !== 0) throw new Error("uv unavailable");
  } catch {
    if (canAct()) ctx.ui.notify("Install uv from https://docs.astral.sh/uv/getting-started/installation/ and restart Pi with uv on PATH, then run /pi-note-setup. Python 3.11+ is required; uv can download it.", "error");
    return;
  }
  if (!canAct() || signal.aborted) return;
  const approved = await ctx.ui.confirm("Install Pinote CLI?",
    "Install/reinstall bundled pinote 0.3.0 in uv's isolated tool environment (may replace an existing uv installation). " +
    "Downloads source and build dependencies; uv may download Python 3.11+. No GTK, shell configuration, or task changes. " +
    `Source: ${cliSource}`);
  if (!approved || !canAct() || signal.aborted) return;
  ctx.ui.notify("Installing Pinote CLI with uv… (up to 3 minutes)", "info");
  const installed = await exec("uv", ["--no-config", "tool", "install", "--reinstall", "--python", ">=3.11", `pinote @ ${cliSource}`], 180000);
  if (signal.aborted) return;
  if (installed.killed || installed.code !== 0) {
    throw new Error(`CLI installation failed or timed out: ${clean(installed.stderr || installed.stdout)}. Check uv/network access and retry /pi-note-setup. Conflicting executables are not overwritten; resolve them manually.`);
  }
  if (!canAct()) return;
  try {
    const version = await exec("note", ["--version"]);
    if (version.killed || version.code !== 0 || !compatibleVersion(version.stdout)) throw new Error("note unavailable or incompatible");
    if (canAct()) ctx.ui.notify(`${clean(version.stdout.trim())} is ready. Use /pi-note. GTK is optional and installed separately.`, "info");
  } catch {
    if (canAct()) ctx.ui.notify("Pinote installed, but note on PATH is missing or incompatible. Run uv tool dir --bin in your terminal, add that directory to PATH before older note executables, restart Pi, then run /pi-note-setup again.", "warning");
  }
}
