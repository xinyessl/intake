// FS-04 consult-to-intake 冒烟：注册 loader hook，把 server import 的 ./db.mjs 换成 cti-db-stub.mjs（无 MySQL 起真 server）。
//   Node 22+ 用 module.register（非废弃的 --loader）。见 lessons L041。
import { register } from 'node:module';
register('./cti-hooks.mjs', import.meta.url);
