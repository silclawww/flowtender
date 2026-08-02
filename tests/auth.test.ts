import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOperatorAuthorized,
  isServiceAuthorized,
  secretsMatch,
} from '../lib/auth.ts';

const OPERATOR_KEY = 'operator-secret-with-enough-entropy';
const SERVICE_KEY = 'service-secret-with-enough-entropy';

function bearer(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

function basic(username: string, password: string): Headers {
  const credentials = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return new Headers({ authorization: `Basic ${credentials}` });
}

test('operator authorization fails closed when the operator key is absent', () => {
  assert.equal(isOperatorAuthorized(bearer(OPERATOR_KEY), undefined), false);
  assert.equal(isOperatorAuthorized(basic('operator', OPERATOR_KEY), ''), false);
});

test('operator APIs accept their dedicated bearer credential', () => {
  assert.equal(isOperatorAuthorized(bearer(OPERATOR_KEY), OPERATOR_KEY), true);
  assert.equal(isOperatorAuthorized(bearer('wrong'), OPERATOR_KEY), false);
});

test('browser inspector accepts only operator Basic credentials', () => {
  assert.equal(isOperatorAuthorized(basic('operator', OPERATOR_KEY), OPERATOR_KEY), true);
  assert.equal(isOperatorAuthorized(basic('admin', OPERATOR_KEY), OPERATOR_KEY), false);
  assert.equal(isOperatorAuthorized(basic('operator', 'wrong'), OPERATOR_KEY), false);
});

test('service authorization is Bearer-only and fails closed', () => {
  assert.equal(isServiceAuthorized(bearer(SERVICE_KEY), SERVICE_KEY), true);
  assert.equal(isServiceAuthorized(basic('operator', SERVICE_KEY), SERVICE_KEY), false);
  assert.equal(isServiceAuthorized(bearer(SERVICE_KEY), undefined), false);
});

test('operator and service credentials are not interchangeable', () => {
  assert.equal(isOperatorAuthorized(bearer(SERVICE_KEY), OPERATOR_KEY), false);
  assert.equal(isServiceAuthorized(bearer(OPERATOR_KEY), SERVICE_KEY), false);
  assert.equal(isServiceAuthorized(basic('operator', OPERATOR_KEY), SERVICE_KEY), false);
});

test('a deployment configured with identical boundary keys fails closed', () => {
  assert.equal(isOperatorAuthorized(bearer(OPERATOR_KEY), OPERATOR_KEY, OPERATOR_KEY), false);
  assert.equal(isServiceAuthorized(bearer(SERVICE_KEY), SERVICE_KEY, SERVICE_KEY), false);
});

test('secret comparison always passes fixed-size digests to timingSafeEqual', () => {
  const comparedLengths: Array<[number, number]> = [];
  const comparator = (candidate: NodeJS.ArrayBufferView, configured: NodeJS.ArrayBufferView) => {
    comparedLengths.push([candidate.byteLength, configured.byteLength]);
    return false;
  };

  assert.equal(secretsMatch('short', 'a much longer configured secret', comparator), false);
  assert.deepEqual(comparedLengths, [[32, 32]]);
});
