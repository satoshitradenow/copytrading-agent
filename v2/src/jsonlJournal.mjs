/** Local prototype only. Production requires a transactional database, fencing
 * against multiple writers, and an order-intent/ack ledger. */
import { existsSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonlJournal {
  constructor(path) {
    if (!path || typeof path !== 'string') throw new Error('journal path required');
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  readAll() {
    if (!existsSync(this.path)) return [];
    const data = readFileSync(this.path, 'utf8');
    if (!data) return [];
    if (!data.endsWith('\n')) throw new Error('Truncated journal; fail closed');
    return data.trimEnd().split('\n').map(line => JSON.parse(line));
  }
  append(record) {
    const line = JSON.stringify(record) + '\n';
    const fd = openSync(this.path, 'a', 0o600);
    try {
      const written = writeSync(fd, line);
      if (written !== Buffer.byteLength(line)) throw new Error('Short journal write');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
}