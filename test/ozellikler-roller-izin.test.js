import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { izinAdlari } from '../src/ozellikler/_mesajlar.js';
import {
  FORBIDDEN_ROLE_PERMISSIONS,
  forbiddenPermissionNames,
  forbiddenPermissionText,
} from '../src/ozellikler/_roller.js';

const roleWith = (...names) => ({ id: '123', permissions: names.reduce((sum, n) => sum | PermissionFlagsBits[n], 0n) });

describe('forbidden role permissions: Turkish names', () => {
  it('every forbidden permission has a name and the table matches the list', () => {
    assert.equal(Object.keys(izinAdlari).length, 18);
    assert.equal(FORBIDDEN_ROLE_PERMISSIONS.length, 18);
    for (const [key, ad] of Object.entries(izinAdlari)) {
      assert.ok(PermissionFlagsBits[key], key);
      assert.deepEqual(forbiddenPermissionNames(roleWith(key)), [ad]);
    }
  });

  it('names only the permissions the role really has', () => {
    assert.deepEqual(forbiddenPermissionNames(roleWith('MentionEveryone', 'SendMessages')), ['Herkesten Bahset']);
    assert.deepEqual(forbiddenPermissionNames(roleWith('SendMessages')), []);
    assert.equal(
      forbiddenPermissionText(roleWith('MentionEveryone'), '<@&123> rolünde'),
      "<@&123> rolünde 'Herkesten Bahset' izni var; bu izin rol menüsü/otomatik rol/seviye rolü için kullanılamaz. Sunucu Ayarları > Roller'den bu izni kapatın.",
    );
    assert.match(
      forbiddenPermissionText(roleWith('MoveMembers', 'ModerateMembers'), 'Rolde'),
      /'Üyelere Zaman Aşımı Uygula', 'Üyeleri Taşı' izinleri var; bu izinler .* bu izinleri kapatın\.$/,
    );
  });
});
