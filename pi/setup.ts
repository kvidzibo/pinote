import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

// Immutable source: the Python app is not yet published to PyPI.
export const cliSource = "https://github.com/kvidzibo/pinote/archive/9c6795f655e6b9d2c51c735fc84b6485fb663bb1.tar.gz";
export const bundledCLIVersion = "0.4.0";
export const setupHint = "Use /pi-note-setup for a missing CLI or /pi-note-upgrade for an older CLI; note must be on PATH.";
export type CLIAction = "setup" | "upgrade" | "ready";

export function cliAction(version: string): CLIAction {
  const match = /^pinote (\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (!match) return "setup";
  const installed = match.slice(1).map(BigInt);
  const bundled = bundledCLIVersion.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (installed[i] < bundled[i]) return "upgrade";
    if (installed[i] > bundled[i]) return "ready";
  }
  return "ready";
}

export async function detectCLI(pi: ExtensionAPI, signal?: AbortSignal): Promise<CLIAction> {
  try {
    const result = await pi.exec("note", ["--version"], { timeout: 5000, signal });
    return !result.killed && result.code === 0 ? cliAction(result.stdout) : "setup";
  } catch { return "setup"; }
}

export function cliMenu(current: AutocompleteProvider, action: () => CLIAction | undefined): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(...args) {
      const suggestions = await current.getSuggestions(...args);
      if (!suggestions || !/^\/\S*$/u.test(suggestions.prefix)) return suggestions;
      const items = suggestions.items.filter(({ value }) => {
        const name = value.replace(/^\//u, "");
        return name === "pi-note-setup" ? action() === "setup"
          : name === "pi-note-upgrade" ? action() === "upgrade" : true;
      });
      return items.length ? { ...suggestions, items } : null;
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
  };
}
export function versionAtLeast(version: string, minimum: string): boolean {
  const match = /^pinote (\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (!match) return false;
  const installed = match.slice(1).map(Number);
  const required = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (installed[i] > required[i]) return true;
    if (installed[i] < required[i]) return false;
  }
  return true;
}
export function compatibleVersion(version: string): boolean {
  return versionAtLeast(version, "0.3.0");
}
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 1500);

export async function setupCLI(
  pi: ExtensionAPI, ctx: ExtensionContext, upgrade: boolean,
  canAct: () => boolean, signal: AbortSignal,
): Promise<void> {
  const exec = (command: string, args: string[], timeout = 5000) =>
    pi.exec(command, args, { timeout, signal });
  const action = await detectCLI(pi, signal);
  if (!canAct() || signal.aborted) return;
  if (action === "ready") {
    ctx.ui.notify(`Pinote CLI is ready (bundled version ${bundledCLIVersion} or newer). Use /pi-note.`, "info");
    return;
  }
  const command = action === "upgrade" ? "/pi-note-upgrade" : "/pi-note-setup";
  if (upgrade !== (action === "upgrade")) {
    ctx.ui.notify(`Use ${command} ${action === "upgrade" ? "to upgrade the older CLI" : "to install the missing CLI"}.`, "info");
    return;
  }
  try {
    const uv = await exec("uv", ["--version"]);
    if (uv.killed || uv.code !== 0) throw new Error("uv unavailable");
  } catch {
    if (canAct()) ctx.ui.notify(`Install uv from https://docs.astral.sh/uv/getting-started/installation/ and restart Pi with uv on PATH, then run ${command}. Python 3.11+ is required; uv can download it.`, "error");
    return;
  }
  if (!canAct() || signal.aborted) return;
  const approved = await ctx.ui.confirm("Install Pinote CLI?",
    `Install bundled pinote ${bundledCLIVersion} in uv's isolated tool environment (may replace an existing uv installation). ` +
    "Downloads source and build dependencies; uv may download Python 3.11+. No GTK, shell configuration, or task changes. " +
    `Source: ${cliSource}`);
  if (!approved || !canAct() || signal.aborted) return;
  const confirmedAction = await detectCLI(pi, signal);
  if (!canAct() || signal.aborted) return;
  if (confirmedAction !== action) {
    ctx.ui.notify("Pinote CLI changed while confirmation was open; installation skipped.", "info");
    return;
  }
  ctx.ui.notify("Installing Pinote CLI with uv… (up to 3 minutes)", "info");
  const installed = await exec("uv", ["--no-config", "tool", "install", "--reinstall", "--python", ">=3.11", `pinote @ ${cliSource}`], 180000);
  if (signal.aborted) return;
  if (installed.killed || installed.code !== 0) {
    throw new Error(`CLI installation failed or timed out: ${clean(installed.stderr || installed.stdout)}. Check uv/network access and retry ${command}. Conflicting executables are not overwritten; resolve them manually.`);
  }
  if (!canAct()) return;
  try {
    const version = await exec("note", ["--version"]);
    if (version.killed || version.code !== 0 || cliAction(version.stdout) !== "ready") throw new Error("note unavailable or older than bundled CLI");
    if (canAct()) ctx.ui.notify(`${clean(version.stdout.trim())} is ready. Use /pi-note. GTK is optional and installed separately.`, "info");
  } catch {
    if (canAct()) ctx.ui.notify("Pinote installed, but note on PATH is missing or older than the bundled CLI. Run uv tool dir --bin in your terminal, add that directory to PATH before older note executables, then restart Pi.", "warning");
  }
}
