import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyProfilePaths } from '../src/environment.ts';

test('startup rejects a relative HOME and parent components in profile paths', () => {
  const keys = ['HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME'];
  verifyProfilePaths({ HOME: '/home/me', XDG_STATE_HOME: '/home/me/state' }, keys);
  assert.throws(() => verifyProfilePaths({ HOME: 'home/me' }, keys), /absolute HOME/);
  assert.throws(() => verifyProfilePaths({ HOME: '/home/me', XDG_STATE_HOME: '/home/me/link/../state' }, keys), /parent-directory/);
  assert.throws(() => verifyProfilePaths({ HOME: '/home/me', XDG_CONFIG_HOME: '/home/me/../config' }, keys), /parent-directory/);
});
