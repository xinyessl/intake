// FS-04 consult-to-intake 冒烟：resolve hook —— 命中 server.mjs 里的 `./db.mjs` 导入即改指向 cti-db-stub.mjs，其余原样。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cti-db-stub.mjs')).href;

export async function resolve(specifier, context, next) {
  if (specifier === './db.mjs' || specifier.endsWith('/db.mjs')) {
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}
