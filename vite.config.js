import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

function copyPublicExtras() {
  return {
    name: 'copy-public-extras',
    closeBundle() {
      // sw.js — deve ficar na raiz do site, sem hash no nome
      copyFileSync('public/sw.js', 'dist/sw.js');

      // .well-known/assetlinks.json
      const wellKnown = 'dist/.well-known';
      if (!existsSync(wellKnown)) mkdirSync(wellKnown, { recursive: true });
      copyFileSync('public/.well-known/assetlinks.json', `${wellKnown}/assetlinks.json`);

      // privacy.html
      copyFileSync('public/privacy.html', 'dist/privacy.html');
    }
  };
}

export default defineConfig({
  plugins: [
    react(),
    copyPublicExtras(),
  ],

  // Pasta com assets estáticos que o Vite copia diretamente para dist/
  // (imagens, manifest.json, capacitor.js, etc.)
  publicDir: 'public',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Não gera hash no nome dos chunks principais para o SW funcionar
    rollupOptions: {
      output: {
        manualChunks: undefined,
      }
    }
  },

  server: {
    port: 3000,
    open: true,
  },
});
