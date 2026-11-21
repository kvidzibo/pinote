import { createPinoteEngine, type EngineOptions } from '../engine.ts';

type Meta = Record<string, unknown> | undefined;
/** Engine host for end-to-end cases: failures become results, views and context are JSON text. */
export function connectEngine(options: EngineOptions = {}) {
  let notify = (): unknown => undefined;
  const engine = createPinoteEngine({ ...options, onChanged: () => { void notify(); } });
  const signal = new AbortController().signal;
  return {
    async callTool({ name, arguments: args, _meta }: { name: string; arguments: unknown; _meta?: Meta }): Promise<{ content: { type: 'text'; text: string }[]; isError?: true; state?: Record<string, unknown> }> {
      try {
        const { result, state } = await engine.tool(name, args, _meta, signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(state ? { state: JSON.parse(JSON.stringify(state)) } : {}) };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
    },
    readView: async (_meta?: Meta) => JSON.stringify(await engine.view(_meta, signal)),
    readContext: (_meta?: Meta) => engine.context(_meta, signal),
    act: async (params: Record<string, unknown>) => JSON.parse(JSON.stringify(await engine.action(params, signal))),
    onChanged(listener: () => unknown) { notify = listener; },
    close: async () => engine.close(),
  };
}
