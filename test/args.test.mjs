import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.mjs';
import { InvalidInputError } from '../src/errors.mjs';

test('--flag value form', () => {
  assert.deepStrictEqual(
    parseArgs(['--version', 'v1.2.3'], { defaults: { version: 'latest' } }),
    { version: 'v1.2.3', help: false },
  );
});

test('--flag=value form', () => {
  assert.deepStrictEqual(
    parseArgs(['--version=v1.2.3', '--mode=report'], { defaults: { version: 'latest', mode: 'annotate' } }),
    { version: 'v1.2.3', mode: 'report', help: false },
  );
});

test('--flag alone is boolean true when declared in booleans', () => {
  assert.deepStrictEqual(
    parseArgs(['--verbose', '--help'], { booleans: ['verbose'] }),
    { verbose: true, help: true },
  );
});

test('boolean flags default to false, --help is always boolean', () => {
  assert.deepStrictEqual(
    parseArgs([], { booleans: ['verbose'] }),
    { verbose: false, help: false },
  );
});

test('defaults are returned for absent flags and overridden when present', () => {
  assert.deepStrictEqual(
    parseArgs([], { defaults: { version: 'latest', report: 'sarif' }, booleans: ['debug'] }),
    { version: 'latest', report: 'sarif', debug: false, help: false },
  );
  assert.deepStrictEqual(
    parseArgs(['--version', 'v2.0.0'], { defaults: { version: 'latest' } }),
    { version: 'v2.0.0', help: false },
  );
});

test('a value is not stolen from a following flag', () => {
  assert.deepStrictEqual(
    parseArgs(['--sarif', '--debug'], { booleans: ['debug'], defaults: { sarif: '' } }),
    { sarif: '--debug', debug: false, help: false },
  );
});

test('boolean flags accept --flag=false but nothing else with =', () => {
  assert.deepStrictEqual(parseArgs(['--help=false']), { help: false });
  assert.throws(() => parseArgs(['--help=yes']), (error) => {
    assert.ok(error instanceof InvalidInputError);
    assert.strictEqual(error.code, 'INVALID_INPUT');
    return true;
  });
});

test('an unknown flag throws InvalidInputError naming the flag and the supported set', () => {
  assert.throws(() => parseArgs(['--verison', 'v1'], { defaults: { version: 'latest' } }), (error) => {
    assert.ok(error instanceof InvalidInputError);
    assert.strictEqual(error.code, 'INVALID_INPUT');
    assert.ok(error.message.includes('--verison'));
    assert.ok(error.message.includes('--version'), 'message lists the supported flags');
    return true;
  });
});

test('a value flag at end of argv with no value throws', () => {
  assert.throws(() => parseArgs(['--version'], { defaults: { version: 'latest' } }), (error) => {
    assert.ok(error instanceof InvalidInputError);
    assert.strictEqual(error.code, 'INVALID_INPUT');
    return true;
  });
});

test('positional arguments throw', () => {
  assert.throws(() => parseArgs(['stray']), (error) => {
    assert.ok(error instanceof InvalidInputError);
    assert.strictEqual(error.code, 'INVALID_INPUT');
    assert.ok(error.message.includes('stray'));
    return true;
  });
});

test('a bare -- with nothing after = throws', () => {
  assert.throws(() => parseArgs(['--']), (error) => {
    assert.ok(error instanceof InvalidInputError);
    assert.strictEqual(error.code, 'INVALID_INPUT');
    return true;
  });
});
