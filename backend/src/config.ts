import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { xdgPath } from './runtime.ts';

export const guiConfigPath = () => join(xdgPath('XDG_CONFIG_HOME', '.config'), 'pinote', 'config.toml');
export class ConfigError extends Error {}
export class GuiConfig {
  readonly max_visible_notes: number | bigint;
  readonly markdown_preview: boolean;
  constructor(max_visible_notes: number | bigint = 10, markdown_preview = true) {
    this.max_visible_notes = max_visible_notes; this.markdown_preview = markdown_preview;
  }
  static load(path = guiConfigPath()): GuiConfig {
    let document: Record<string, any>;
    try { document = parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)), { integersAsBigInt: true }); }
    catch (error: any) {
      if (error.code === 'ENOENT') return new GuiConfig();
      throw new ConfigError(`Cannot read GUI config ${path}: ${error.message}`);
    }
    const section = Object.hasOwn(document, 'gui') ? document.gui : {};
    const fail = (message: string): never => { throw new ConfigError(`Invalid GUI config ${path}: ${message}`); };
    if (!section || typeof section !== 'object' || Array.isArray(section) || section instanceof Date)
      fail('[gui] must be a table.');
    const get = (key: string, fallback: any) => Object.hasOwn(section, key) ? section[key] : fallback;
    const limit = get('max_visible_notes', 10);
    if (!(Object.hasOwn(section, 'max_visible_notes') ? typeof limit === 'bigint' && limit >= 1n : limit === 10))
      fail('gui.max_visible_notes must be a positive integer.');
    const markdown = get('markdown_preview', true);
    if (typeof markdown !== 'boolean') fail('gui.markdown_preview must be a boolean.');
    return new GuiConfig(limit, markdown);
  }
}
