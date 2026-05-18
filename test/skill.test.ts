import { describe, expect, it } from 'vitest';
import { renderSkill, renderToolsTable } from '../src/skill.js';
import { TOOL_NAMES } from '../src/tools.js';

describe('skill renderer', () => {
  it('produces a markdown table with one row per tool', () => {
    const md = renderToolsTable();
    expect(md.startsWith('| # | Tool | Description |')).toBe(true);
    expect(md.split('\n').length).toBe(2 + TOOL_NAMES.length);
  });

  it('injects every tool name into rendered SKILL.md', () => {
    const out = renderSkill();
    for (const name of TOOL_NAMES) {
      expect(out).toContain(`\`${name}\``);
    }
  });

  it('preserves the frontmatter and Preamble section', () => {
    const out = renderSkill();
    expect(out.startsWith('---\nname: n-payment\n')).toBe(true);
    expect(out).toContain('## Preamble (run first)');
    expect(out).toContain('## Completion status');
  });

  it('replaces the placeholder block exactly once', () => {
    const out = renderSkill();
    const matches = out.match(/<!-- TOOLS:START -->/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
