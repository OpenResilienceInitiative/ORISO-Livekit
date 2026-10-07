const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_DIRECTORY = join(__dirname, '..');

let tempDirectory;
let completeEnvironment;

before(() => {
	tempDirectory = mkdtempSync(join(tmpdir(), 'matrixrtc-config-'));
	const tokenFile = join(tempDirectory, 'token');
	writeFileSync(tokenFile, 'test-token', { mode: 0o600 });
	completeEnvironment = {
		NODE_ENV: 'test',
		PORT: '0',
		MATRIXRTC_ALLOWED_ORIGINS: 'https://call.example.org',
		MATRIX_SERVER_NAME: 'matrix.example.org',
		MATRIX_FEDERATION_BASE_URL: 'https://matrix.example.org',
		MATRIX_CLIENT_BASE_URL: 'https://matrix.example.org',
		MATRIX_MEMBERSHIP_TOKEN_FILE: tokenFile,
		MATRIXRTC_UPSTREAM_URL: 'http://authorization-service.example.test:8080',
		MATRIXRTC_CALL_POLICY_URL:
			'http://userservice.example.test:8080/internal/matrixrtc/call-policy',
		MATRIXRTC_CALL_POLICY_TOKEN_FILE: tokenFile
	};
});

after(() => {
	rmSync(tempDirectory, { recursive: true, force: true });
});

// Only the startup check runs: a valid config would start listening, so the
// child gets a short timeout and a missing/invalid value must exit before it.
const startWith = (environment) =>
	spawnSync(process.execPath, ['server.js'], {
		cwd: SERVICE_DIRECTORY,
		env: { PATH: process.env.PATH, ...environment },
		encoding: 'utf8',
		timeout: 3000
	});

const REQUIRED_VARIABLES = [
	'MATRIXRTC_ALLOWED_ORIGINS',
	'MATRIX_SERVER_NAME',
	'MATRIX_FEDERATION_BASE_URL',
	'MATRIX_CLIENT_BASE_URL',
	'MATRIX_MEMBERSHIP_TOKEN_FILE',
	'MATRIXRTC_UPSTREAM_URL',
	'MATRIXRTC_CALL_POLICY_URL',
	'MATRIXRTC_CALL_POLICY_TOKEN_FILE'
];

for (const variable of REQUIRED_VARIABLES) {
	test(`refuses to start without ${variable} and names it`, () => {
		const environment = { ...completeEnvironment };
		delete environment[variable];

		const result = startWith(environment);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, new RegExp(`\\b${variable}\\b`));
	});
}

for (const variable of ['MATRIXRTC_UPSTREAM_URL', 'MATRIXRTC_CALL_POLICY_URL']) {
	for (const invalid of ['/relative/path', 'not a url', 'ftp://host.example.test']) {
		test(`refuses to start when ${variable} is "${invalid}" and names it`, () => {
			const result = startWith({ ...completeEnvironment, [variable]: invalid });

			assert.notEqual(result.status, 0);
			assert.match(result.stderr, new RegExp(`\\b${variable}\\b`));
		});
	}
}
