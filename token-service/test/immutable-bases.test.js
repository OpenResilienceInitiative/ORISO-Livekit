const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const digestPattern = /@sha256:[a-f0-9]{64}/;

test('all gateway and issuer container bases are pinned by digest', () => {
	const dockerfiles = [
		resolve(__dirname, '../Dockerfile'),
		resolve(__dirname, '../../authorization-service/Dockerfile')
	];

	for (const dockerfile of dockerfiles) {
		const fromLines = readFileSync(dockerfile, 'utf8')
			.split('\n')
			.filter((line) => line.startsWith('FROM '));

		assert.ok(fromLines.length > 0, `${dockerfile} has no FROM line`);
		assert.equal(
			fromLines.every(
				(line) => line.startsWith('FROM scratch') || digestPattern.test(line)
			),
			true,
			`${dockerfile} contains an unpinned container base`
		);
	}
});
