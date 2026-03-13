import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

export const TSX_LOADER_SPECIFIER =
  typeof import.meta.resolve === 'function'
    ? import.meta.resolve('tsx')
    : pathToFileURL(require.resolve('tsx')).href;
