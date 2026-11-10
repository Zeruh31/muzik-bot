// /disconnect: /stop ile aynı işi yapar (eski botta iki adı da vardı).
import { guildCommand } from './_helpers.js';

export { execute } from './stop.js';

export const data = guildCommand('disconnect');
