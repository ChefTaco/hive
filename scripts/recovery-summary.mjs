import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(`Recovery result: **${report.result}**, seed scale ${report.seedScale}, total ${report.wrapperSeconds?.toFixed(3)} s.\n`);
console.log('| Phase | Seconds | Result |\n|---|---:|---|');
for (const row of report.phases) console.log(`| ${row.name} | ${row.seconds.toFixed(3)} | ${row.result} |`);
console.log(`| Root ownership checks | ${report.ownershipSeconds?.toFixed(3) ?? 'unavailable'} | included |`);
console.log(`| Wrapper setup/ownership handback | ${report.wrapperOverheadSeconds?.toFixed(3)} | included |`);
console.log(`\nFirst online backup: ${report.online?.seconds} s; data ${(report.online?.dataBytes / 1048576).toFixed(1)} MiB; longest pause ${report.online?.longestPauseSeconds} s. Both restores and all failure cases run at either corpus size.`);
