// Opt-in, real macOS custody smoke. Only runtime-generated disposable canaries.
// Values never enter assertions, stdout, error causes or retained receipts.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { keychain, resolveBackend, run } from '../dist/index.js';

if (process.platform !== 'darwin' || process.env.FERRY_KEYCHAIN_SMOKE !== '1') {
  console.error('Requires macOS and explicit FERRY_KEYCHAIN_SMOKE=1.');
  process.exit(2);
}

const receipt = { schema: 'ferry-keychain-smoke/1', checkedAt: new Date().toISOString(),
  packageConsumer: 'dist/index.js', syntheticOnly: true, status: 'failed', checks: {}, cleanup: {} };
const directory = mkdtempSync(join(tmpdir(), 'ferry-keychain-smoke-'));
const path = join(directory, 'isolated.keychain-db');
const password = randomBytes(32).toString('hex');
const value = ` ${randomBytes(32).toString('hex')} `;
const item = { service: 'org.example.ferry.synthetic', account: randomBytes(12).toString('hex'), keychainPath: path };
let creationAttempted = false;
let searchList;
let stage = 'observe-search-list';

// The provisioning argv below contains generated canaries only. Production
// import/write operations need a separate protected native API, never this lane.
const security = args => new Promise((resolve, reject) => {
  execFile('/usr/bin/security', args, { encoding: 'utf8', env: {}, shell: false,
    timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 65_536 }, (error, stdout) => {
    if (error) reject(new Error('synthetic keychain operation failed'));
    else resolve(stdout);
  });
});
function requireCheck(name, passed) {
  receipt.checks[name] = passed;
  if (!passed) throw new Error('synthetic check failed');
}

try {
  searchList = await security(['list-keychains', '-d', 'user']);
  stage = 'create-isolated-keychain';
  creationAttempted = true;
  await security(['create-keychain', '-p', password, path]);
  await security(['unlock-keychain', '-p', password, path]);
  await security(['add-generic-password', '-a', item.account, '-s', item.service, '-w', value, '-T', '/usr/bin/security', path]);
  stage = 'package-resolution';
  const resolved = await resolveBackend(keychain(item)).resolve(keychain(item).ref);
  requireCheck('exactValueAndWhitespace', resolved === value);
  stage = 'missing-item-denial';
  const missing = keychain({ ...item, account: `${item.account}-missing` });
  let safeDenial = false;
  try { await resolveBackend(missing).resolve(missing.ref); }
  catch (error) { safeDenial = String(error) === 'Error: keychain backend: item unavailable or access denied'; }
  requireCheck('missingItemSafeDenial', safeDenial);
  stage = 'package-runner';
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  const audit = join(directory, 'audit.jsonl');
  const result = await run({
    config: { secrets: { CANARY: { backend: keychain(item), allow: ['*'] } }, audit, cleanEnv: true },
    commandArgv: [process.execPath, '-e', 'process.stdout.write(process.env.CANARY)'],
    deps: { stdout: sink, stderr: sink },
  });
  requireCheck('runnerSucceeded', result.exitCode === 0);
  requireCheck('outputRedacted', output === '[redacted:CANARY]');
  requireCheck('metadataAndAuditValueFree', !JSON.stringify(result).includes(value) &&
    !readFileSync(audit, 'utf8').includes(value));
  stage = 'policy-denial';
  let policyDenied = false;
  try {
    await run({ config: { secrets: { CANARY: { backend: keychain(item), allow: ['approved-tool'] } }, audit },
      commandArgv: ['unapproved-tool'], only: ['CANARY'], cleanEnv: true });
  } catch (error) { policyDenied = String(error).includes('not allowed'); }
  requireCheck('policyDenied', policyDenied);
  receipt.status = 'passed';
} catch {
  receipt.failedStage = stage;
} finally {
  if (creationAttempted) {
    try {
      await security(['delete-keychain', path]);
      receipt.cleanup.keychainDeleteCommand = true;
    } catch { receipt.cleanup.keychainDeleteCommand = false; }
  }
  receipt.cleanup.keychainFileAbsent = !existsSync(path) && !existsSync(`${path}-db`);
  try { receipt.cleanup.searchListUnchanged = searchList !== undefined && await security(['list-keychains', '-d', 'user']) === searchList; }
  catch { receipt.cleanup.searchListUnchanged = false; }
  // Do not hide a failed OS delete by deleting its files ourselves.
  if (receipt.cleanup.keychainFileAbsent) {
    rmSync(directory, { recursive: true, force: true });
    receipt.cleanup.temporaryDirectoryRemoved = !existsSync(directory);
  } else {
    receipt.cleanup.temporaryDirectoryRemoved = false;
    receipt.cleanup.remainingSyntheticDirectory = directory;
  }
  if (Object.values(receipt.cleanup).some(result => result !== true)) receipt.status = 'failed';
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.status === 'passed' ? 0 : 1;
}
