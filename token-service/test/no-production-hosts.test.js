const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPOSITORY_ROOT = join(__dirname, '..', '..');

// Code, tests and fixtures must never name a real ORISO environment: a copied
// default or fixture would silently point another installation at it.
const FORBIDDEN_HOST = /\boriso\.(org|site)\b|\boriso-dev\.site\b/i;

test('no tracked file names a real ORISO host', () => {
	const files = execFileSync('git', ['ls-files'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8'
	})
		.split('\n')
		.filter(Boolean)
		.filter((file) => !file.endsWith('package-lock.json'));

	const hits = [];
	for (const file of files) {
		const lines = readFileSync(join(REPOSITORY_ROOT, file), 'utf8').split('\n');
		lines.forEach((line, index) => {
			if (FORBIDDEN_HOST.test(line)) hits.push(`${file}:${index + 1}`);
		});
	}

	assert.deepEqual(hits, [], 'use example.org / example.test hosts instead');
});
