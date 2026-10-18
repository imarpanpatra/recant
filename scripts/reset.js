import 'dotenv/config';
import { one, close } from '../src/db.js';
import { WIPE } from '../src/queries.js';

try {
  await one('reset.wipe', WIPE);
  console.log('graph wiped');
} finally {
  await close();
}
