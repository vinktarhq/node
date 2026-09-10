// Post-processes the source maps tsup wrote.
//
//   - `ignoreList` (and the older `x_google_ignoreList`) marks every source as SDK code, so a
//     customer's devtools collapse these frames and step over them. An error tracking SDK that
//     clutters the stack it is trying to show you is a poor guest.
//   - `sourcesContent` is dropped. The map still resolves positions; it just does not carry a copy
//     of the whole source tree, which was most of the tarball.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
for (const entry of readdirSync(dist, { recursive: true })) {
  const name = String(entry);
  if (!name.endsWith('.map')) continue;
  const path = join(dist, name);
  const map = JSON.parse(readFileSync(path, 'utf8'));
  const all = (map.sources ?? []).map((_, index) => index);
  map.ignoreList = all;
  map.x_google_ignoreList = all;
  delete map.sourcesContent;
  writeFileSync(path, JSON.stringify(map));
}
