import { test } from 'node:test';
import { checkClientProfile } from './fixtures/client-profile.js';
test('update-only client omits mount and unused context services', () => checkClientProfile(true));
