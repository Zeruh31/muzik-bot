// Sesli komut işçisinin Python tarafındaki iş kuyruğu (stt/kuyruk.py): ikinci geçiş önce, dolu kuyrukta en
// eski atılır, 4 sn'den eski cümle atılır, tutulan ses 15 sn sonra ve "end" gelince silinir. Yalnız standart
// kütüphane; bilgisayarda Python yoksa test atlanır.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TESTS = fileURLToPath(new URL('../stt/test_kuyruk.py', import.meta.url));
const python = ['python', 'python3', 'py'].find(
  (cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0,
);

it('stt/kuyruk.py birim testleri', { skip: python ? false : 'Python bulunamadı' }, () => {
  const result = spawnSync(python, ['-I', '-B', TESTS], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /OK/);
});
