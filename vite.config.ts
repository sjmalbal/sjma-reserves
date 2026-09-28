import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: true,
    lib: {
      entry: {
        catalogue: resolve(import.meta.dirname, 'src/client/catalogue.ts'),
        admin: resolve(import.meta.dirname, 'src/client/admin.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  },
});
