/* Streaming zip extraction. Uses yauzl so we don't buffer the whole upload
 * in memory — useful when game devs upload images bundles with their game
 * server (a few hundred MB is realistic). */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB hard cap per upload
const MAX_FILES = 20_000;

export class ExtractError extends Error {}

/** Extract `zipBuffer` into `destDir`. Rejects path-traversal entries (zip
 *  slip), enforces size + file-count caps, and returns the list of paths
 *  written (relative to destDir) plus the total uncompressed bytes. */
export async function extractZip(
  zipBuffer: Buffer,
  destDir: string,
): Promise<{ files: string[]; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(new ExtractError(`Could not open zip: ${err.message}`));
        return;
      }
      const files: string[] = [];
      let totalBytes = 0;

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        // Skip the __MACOSX / .DS_Store junk macOS likes to ship in zips.
        const fileName = entry.fileName;
        if (fileName.startsWith('__MACOSX/') || fileName.endsWith('/.DS_Store') || fileName === '.DS_Store') {
          zipfile.readEntry();
          return;
        }

        const safePath = safeJoin(destDir, fileName);
        if (!safePath) {
          reject(new ExtractError(`Refusing zip-slip path: ${fileName}`));
          zipfile.close();
          return;
        }

        // Directory entry.
        if (/\/$/.test(fileName)) {
          mkdirSync(safePath, { recursive: true });
          zipfile.readEntry();
          return;
        }

        // Pre-flight size + file-count checks.
        totalBytes += entry.uncompressedSize;
        files.push(fileName);
        if (totalBytes > MAX_TOTAL_BYTES) {
          reject(new ExtractError(`Bundle exceeds ${MAX_TOTAL_BYTES} bytes cap`));
          zipfile.close();
          return;
        }
        if (files.length > MAX_FILES) {
          reject(new ExtractError(`Bundle exceeds ${MAX_FILES}-file cap`));
          zipfile.close();
          return;
        }

        mkdirSync(dirname(safePath), { recursive: true });

        zipfile.openReadStream(entry, async (rsErr, readStream) => {
          if (rsErr) {
            reject(new ExtractError(`Could not read entry ${fileName}: ${rsErr.message}`));
            return;
          }
          try {
            await pipeline(readStream, createWriteStream(safePath));
            zipfile.readEntry();
          } catch (writeErr) {
            reject(new ExtractError(`Failed to write ${fileName}: ${(writeErr as Error).message}`));
          }
        });
      });

      zipfile.on('end', () => resolve({ files, totalBytes }));
      zipfile.on('error', (e) => reject(new ExtractError(`Zip error: ${e.message}`)));
    });
  });
}

/** Resolve `name` under `root`, returning null if it escapes via `..` or an
 *  absolute path. Zip Slip prevention. */
function safeJoin(root: string, name: string): string | null {
  const normalizedName = normalize(name).replace(/^([/\\]+)/, '');
  const joined = join(root, normalizedName);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!joined.startsWith(rootWithSep) && joined !== root) return null;
  return joined;
}
