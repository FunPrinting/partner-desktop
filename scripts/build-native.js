'use strict';

/**
 * Builds the Windows print add-on and puts it where the app loads it:
 *   native/fp-print/fp-print.node  (the cargo cdylib, renamed) and pdfium.dll
 *
 *   node scripts/build-native.js [x64|arm64]
 *
 * Needs Rust (rustup) and runs on Windows. On other systems it does nothing: macOS and
 * Linux print through CUPS and need no native code.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Not Windows: the native print add-on is not needed here.');
  process.exit(0);
}
const arch = process.argv[2] || (process.arch === 'arm64' ? 'arm64' : 'x64');
const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
const dir = path.join(__dirname, '..', 'native', 'fp-print');

execFileSync('node', [path.join(__dirname, 'fetch-pdfium.js'), arch], { stdio: 'inherit' });
execFileSync('cargo', ['build', '--release', '--target', target], { cwd: dir, stdio: 'inherit' });
fs.copyFileSync(path.join(dir, 'target', target, 'release', 'fp_print.dll'), path.join(dir, 'fp-print.node'));
console.log(`Built native/fp-print/fp-print.node (${arch})`);
