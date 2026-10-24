import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

type Task = { id: number; text: string; updated_at: string; state: string };
type Current = { task: Task | null; database?: string };
const complete = "Complete task and exit";
const leave = "Exit without completing";
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
function task(value: unknown): Task | null {
  if (value === null) return null;
  const item = value as Task | undefined;
  if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.text !== "string" ||
      typeof item.updated_at !== "string" || !item.updated_at ||
      !["active", "in_progress", "done"].includes(item.state)) throw new Error("Invalid Pinote task response");
  return item;
}
function same(left: Task | null, right: Task): boolean {
  return left?.id === right.id && left.updated_at === right.updated_at && left.text === right.text && left.state === right.state;
}

// Optional MCP companion: deliberately absent from package.json's default extensions.
export default function (pi: ExtensionAPI) {
  let invalidate: (() => void) | undefined;
  let stop: (() => void) | undefined;
  const readCurrent = async (): Promise<Current> => {
    const replies: { handled?: boolean; error?: string; result?: Promise<unknown> }[] = [];
    pi.events.emit("gateway:query-service-tool", {
      service: "pinote", tool: "get_current",
      respond: (reply: typeof replies[number]) => {
        if (reply.handled) { replies.push(reply); void reply.result?.catch(() => {}); }
      },
    });
    if (replies.length !== 1 || replies[0].error || !replies[0].result) {
      throw new Error(replies[0]?.error || "Pinote gateway service unavailable; use /quit to exit without completing");
    }
    const result = await replies[0].result as {
      isError?: boolean; content?: { type: string; text?: string }[]; _meta?: Record<string, unknown>;
    };
    if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text || "Pinote query failed");
    const raw = result.content?.find((item) => item.type === "text")?.text;
    if (raw === undefined) throw new Error("Missing Pinote task response");
    const value = task(JSON.parse(raw));
    if (value && !["active", "in_progress"].includes(value.state)) throw new Error("Pinote task is no longer active");
    const database = result._meta?.["pinote/database"];
    return { task: value, database: typeof database === "string" ? database : undefined };
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const previous = ctx.ui.getEditorComponent();
    let alive = true, pending = false, epoch = 0;
    let controller: AbortController | undefined;
    invalidate = () => { epoch++; controller?.abort(); };
    const exit = async () => {
      if (pending || !alive) return;
      pending = true;
      const generation = epoch;
      const operation = controller = new AbortController();
      const current = () => alive && generation === epoch && !operation.signal.aborted &&
        ctx.ui.getEditorText().length === 0;
      const shutdown = () => { if (!ctx.isIdle()) ctx.abort(); ctx.shutdown(); };
      const run = async (args: string[]) => {
        if (!current()) throw new Error("Pinote exit cancelled: session changed or became busy");
        const result = await pi.exec(process.env.PINOTE_NOTE_COMMAND || "note", args, { timeout: 10_000, signal: operation.signal });
        if (result.killed || result.code !== 0) throw new Error(clean(result.stderr || result.stdout || "Pinote CLI failed or timed out"));
        return result.stdout;
      };
      try {
        const selected = await readCurrent();
        if (!current()) return;
        if (!selected.task) { shutdown(); return; }
        const approved = selected.task;
        const title = truncateToWidth(clean(approved.text.split("\n", 1)[0]), 70);
        const choice = await ctx.ui.select(`Pinote · ${title}`, [complete, leave, "Cancel"], { signal: operation.signal });
        if (!current()) return;
        if (choice === leave) { shutdown(); return; }
        if (choice !== complete) return;
        if (!ctx.isIdle()) throw new Error("Wait for Pi to become idle before completing a task");
        const dataHome = process.env.XDG_DATA_HOME;
        const localDatabase = join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local/share"), "pinote/notes.db");
        if (!selected.database || !isAbsolute(selected.database) ||
            await realpath(selected.database) !== await realpath(localDatabase)) {
          throw new Error("Pinote database mismatch: update the MCP server and use the same XDG_DATA_HOME in Pi and the service");
        }
        const version = (await run(["--version"])).trim();
        const match = /^pinote (\d+)\.(\d+)\.(\d+)$/.exec(version);
        if (!match || Number(match[1]) === 0 && Number(match[2]) < 12) throw new Error("Pinote exit confirmation requires note 0.12.0+");
        const local = task(JSON.parse(await run(["--no-notify", "agent", "get", String(approved.id)])));
        const fresh = await readCurrent();
        if (!same(local, approved) || !same(fresh.task, approved) || fresh.database !== selected.database) {
          throw new Error("Pinote task changed; inspect it before retrying");
        }
        const done = task(JSON.parse(await run(["--no-notify", "agent", "done", String(approved.id), "--expected-updated-at", approved.updated_at])));
        if (done?.id !== approved.id || done.state !== "done") throw new Error("Unexpected completion response; inspect the task before retrying");
        if (current() && !(await readCurrent()).task && current()) shutdown();
        else if (current()) ctx.ui.notify("Task completed; Pi stayed open because the selection changed", "info");
      } catch (error) {
        if (alive && generation === epoch) ctx.ui.notify(`Pinote: ${clean(String(error))}. Pi stayed open; inspect the task before retrying. /quit exits without completing.`, "error");
      } finally { pending = false; }
    };
    const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keybindings) => {
      const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        if (keybindings.matches(data, "app.exit") && editor.getText().length === 0) { void exit(); return; }
        handleInput(data);
      };
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
    stop = () => {
      alive = false;
      invalidate?.();
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
    };
  });
  pi.on("session_shutdown", () => { stop?.(); stop = invalidate = undefined; });
  // Retire in-flight dialogs/reads before navigation or a new agent run can act.
  const interrupted = () => { invalidate?.(); };
  pi.on("session_before_switch", interrupted);
  pi.on("session_before_fork", interrupted);
  pi.on("session_before_tree", interrupted);
  pi.on("agent_start", interrupted);
}
