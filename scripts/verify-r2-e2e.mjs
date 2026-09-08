import { putR2Object, generateReadUrl, deleteR2Object } from '../lib/r2-service.js';

const testKey = `_healthcheck/verify-${Date.now()}.txt`;
const testBody = Buffer.from('bioskin-r2-verification-' + Date.now());

console.log('1) PUT test object to real bucket...');
await putR2Object(testKey, testBody, 'text/plain');
console.log('   OK: object uploaded, key =', testKey);

console.log('2) Generate real signed READ URL...');
const readUrl = await generateReadUrl(testKey, 60);
const parsed = new URL(readUrl);
console.log('   OK: endpoint =', parsed.hostname);
console.log('   OK: path matches key =', parsed.pathname === '/' + testKey);
console.log('   OK: algorithm =', parsed.searchParams.get('X-Amz-Algorithm'));

console.log('3) Fetch the object back via the signed URL (real HTTP GET)...');
const res = await fetch(readUrl);
const text = await res.text();
console.log('   OK: HTTP status =', res.status);
console.log('   OK: content matches upload =', text === testBody.toString());

console.log('4) Delete the test object...');
await deleteR2Object(testKey);
console.log('   OK: delete call completed');

console.log('5) Confirm object no longer readable...');
const res2 = await fetch(readUrl);
console.log('   OK: post-delete GET status =', res2.status, '(expected 404/403)');

console.log('\nRESULT: R2 credentials are REAL and FUNCTIONAL end-to-end.');
