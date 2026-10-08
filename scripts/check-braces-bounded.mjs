import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const store=fileURLToPath(new URL('../node_modules/.pnpm/',import.meta.url));
const consumers=readdirSync(store).filter(x=>x.startsWith('micromatch@'));
assert.ok(consumers.length>0, 'real micromatch consumer must be installed');
const installed=createRequire(join(store,consumers[0],'node_modules/micromatch/package.json'));
const braces = installed('braces');

test('retains ordinary compilation, expansion and literal brace behavior', () => {
  assert.deepEqual(braces('src/{a,b}/file'), ['src/(a|b)/file']);
  assert.deepEqual(braces.expand('file-{1..3}.txt'), ['file-1.txt','file-2.txt','file-3.txt']);
  assert.deepEqual(braces.expand('{a,{b,c}}'), ['a','b','c']);
  assert.doesNotThrow(() => braces('\\{'.repeat(1000)));
  assert.doesNotThrow(() => braces('"' + '{'.repeat(500) + '"'));
});
test('rejects deep parser input without a caller bypass', () => {
  const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
  for (const fn of [braces, braces.compile, braces.expand, braces.parse])
    assert.throws(() => fn(pattern), /safe depth limit/);
  assert.throws(() => braces('{'.repeat(200)+'a,b'+'}'.repeat(200), {maxDepth:10000}), /safe depth limit/);
});
test('bounds direct recursive AST walkers', () => {
  const ast = {type:'root',nodes:[]}; let node=ast;
  for(let i=0;i<4000;i++){const child={type:'root',nodes:[],parent:node};node.nodes.push(child);node=child;}
  node.nodes.push({type:'text',value:'a'});
  for(const fn of [braces.compile,braces.expand,braces.stringify]) assert.throws(() => fn(ast), /safe depth limit/);
});
test('does not log pattern content', () => {
  const original = console.log; const calls=[];
  console.log=(...args)=>calls.push(args);
  try { braces('{a}'); assert.equal(calls.length,0); } finally { console.log=original; }
});
test('installed micromatch resolves the bounded fork and preserves matching', () => {
  const store=fileURLToPath(new URL('../node_modules/.pnpm/',import.meta.url));
  const consumers=readdirSync(store).filter(x=>x.startsWith('micromatch@'));
  assert.ok(consumers.length>0, 'real micromatch consumer must be installed');
  for(const dir of consumers){
    const local=createRequire(join(store,dir,'node_modules/micromatch/package.json'));
    assert.equal(local('braces/package.json').name,'@lucentive-labs/braces-bounded');
    const actual=local('braces');
    assert.throws(()=>actual('{'.repeat(200)+'a,b'+'}'.repeat(200)),/safe depth limit/);
    const match=local('micromatch');
    assert.deepEqual(match(['src/a.ts','src/b.ts','src/c.js'],'src/{a,b}.ts'),['src/a.ts','src/b.ts']);
  }
  const lock=readFileSync(new URL('../pnpm-lock.yaml',import.meta.url),'utf8');
  assert.doesNotMatch(lock,/braces@3\.0\.3:/);
  assert.match(lock,/braces-bounded/);
});
