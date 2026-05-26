// app/server/src/fs-utils.ts
// Shared filesystem utilities used by multiple modules.

import { unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { getConfig } from './config.js';
import { childLogger } from './logger.js';

const logger = childLogger('fs-utils');

/**
 * Delete a file by absolute or relative (under STORAGE_PATH) path.
 * Swallows ENOENT so callers don't need to guard against already-missing files.
 * Any other error is logged at warn level but does not throw.
 */
export async function deleteFileBestEffort(absOrRel: string): Promise<void> {
  const cfg = getConfig();
  const abs = isAbsolute(absOrRel) ? absOrRel : join(cfg.STORAGE_PATH, absOrRel);
  await unlink(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') {
      logger.warn({ path: abs, err: err.message }, 'failed to delete file');
    }
  });
}
