import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Provide the JUnit test report path');
const report = readFileSync(path, 'utf8');
const summary = report.match(/<testsuites\b[^>]*\btests="(\d+)"[^>]*>/);
if (!summary || Number(summary[1]) === 0) throw new Error('Test report contains no executed tests');
if (/<skipped\b/.test(report) || /\b(?:skipped|failures|errors)="[1-9]\d*"/.test(report)) {
  throw new Error('OSS tests must finish with zero failures, errors, skips and todos');
}
console.log(`Verified ${summary[1]} tests with zero failures, errors, skips and todos`);
