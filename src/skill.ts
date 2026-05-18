// Skill renderer.
//
// `renderSkill()` reads the canonical SKILL.md template (shipped with this
// package) and injects the live tools list into the
// <!-- TOOLS:START --> … <!-- TOOLS:END --> block so the SKILL.md the user
// installs always reflects the registry that is actually loaded.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.js';

const TOOLS_PLACEHOLDER = /<!-- TOOLS:START -->[\s\S]*?<!-- TOOLS:END -->/;

/** Walk up from this module looking for SKILL.md (works in src/, dist/, npm install). */
function locateTemplate(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const c = join(dir, 'SKILL.md');
    if (existsSync(c)) return c;
    dir = dirname(dir);
  }
  throw new Error('SKILL.md template not found beside the package.');
}

/** Markdown table of all tools. */
export function renderToolsTable(): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = TOOLS.map(
    (t, i) => `| ${i + 1} | \`${t.name}\` | ${escape(t.description)} |`,
  );
  return ['| # | Tool | Description |', '|---|------|-------------|', ...rows].join('\n');
}

/** Final SKILL.md content with tools injected. */
export function renderSkill(templatePath: string = locateTemplate()): string {
  const tpl = readFileSync(templatePath, 'utf8');
  const block = `<!-- TOOLS:START -->\n${renderToolsTable()}\n<!-- TOOLS:END -->`;
  if (!TOOLS_PLACEHOLDER.test(tpl)) {
    throw new Error('SKILL.md is missing the <!-- TOOLS:START --> placeholder.');
  }
  return tpl.replace(TOOLS_PLACEHOLDER, block);
}
