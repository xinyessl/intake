import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Library-mode IIFE does not inherit Vite app-mode's NODE_ENV replacement.
  // Inline it at build time so React/AntD never require a browser-global process shim.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': JSON.stringify({ NODE_ENV: 'production' }),
  },
  build: {
    outDir: path.resolve(HERE, '../../public/assets/field-overview'),
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: path.resolve(HERE, 'src/entry.jsx'),
      name: 'IntakeFieldOverviewBundle',
      formats: ['iife'],
      fileName: () => 'field-overview.js',
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'field-overview.css' : 'field-overview-[name][extname]',
      },
    },
  },
});
