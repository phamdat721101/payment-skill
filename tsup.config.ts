import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    tools: 'src/tools.ts',
  },
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: ({ format }) => ({
    js: format === 'esm' ? '#!/usr/bin/env node' : '',
  }),
  // Only put the shebang on the CLI bundle, not on the library entries.
  esbuildOptions(options, ctx) {
    if (ctx.format === 'esm' && options.entryPoints) {
      // tsup applies banner to all entries; we strip shebang from non-cli files in onSuccess.
    }
  },
  onSuccess: 'node -e "import(\'node:fs\').then(fs=>{[\'dist/index.js\',\'dist/tools.js\'].forEach(f=>{const s=fs.readFileSync(f,\'utf8\');if(s.startsWith(\'#!\'))fs.writeFileSync(f,s.replace(/^#![^\\n]*\\n/,\'\'));});require(\'node:fs\').chmodSync(\'dist/cli.js\',0o755);})"',
});
