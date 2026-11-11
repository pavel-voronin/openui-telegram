import { test } from 'node:test';
import { checkClientProfile } from './fixtures/client-profile.js';
test('capability-free client keeps HTML updates without lifecycle services', () => checkClientProfile(false));
