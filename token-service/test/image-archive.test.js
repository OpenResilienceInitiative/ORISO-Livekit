const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const test = require('node:test');

const scripts = resolve(__dirname, '../../scripts/ci');
const platforms = ['amd64', 'arm64'];
const index = JSON.stringify({
	schemaVersion: 2,
	mediaType: 'application/vnd.oci.image.index.v1+json',
	manifests: platforms.map((architecture, position) => ({
		digest: 'sha256:' + String(position + 1).repeat(64),
		mediaType: 'application/vnd.oci.image.manifest.v1+json',
		platform: { os: 'linux', architecture }
	}))
});
const digest = 'sha256:' + createHash('sha256').update(index).digest('hex');

const fakeSkopeo = `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const index = process.env.FAKE_INDEX;
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['skopeo', ...args]) + '\\n');
if (args.includes('inspect')) {
	process.stdout.write(index);
} else if (args.includes('manifest-digest')) {
	const bytes = fs.readFileSync(args.at(-1));
	process.stdout.write('sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') + '\\n');
} else if (args.includes('copy')) {
	const indexDigest = 'sha256:' + crypto.createHash('sha256').update(index).digest('hex');
	const architecture = args.includes('--override-arch') ? args[args.indexOf('--override-arch') + 1] : null;
	const manifests = JSON.parse(index).manifests;
	const selectedArch = architecture === process.env.FAKE_WRONG_ARCH ? 'amd64' : architecture;
	const descriptor = manifests.find(image => image.platform.architecture === selectedArch);
	fs.writeFileSync(args[args.indexOf('--digestfile') + 1], (descriptor?.digest ?? indexDigest) + '\\n');
} else {
	process.exit(2);
}
`;

const fakeTrivy = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['trivy', ...args]) + '\\n');
process.exit(args.includes(process.env.FAKE_FAIL_PLATFORM) ? 1 : 0);
`;

function imageFixture(t) {
	const directory = mkdtempSync(join(tmpdir(), 'livekit-archive-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));

	const archive = join(directory, 'image.tar');
	const receipt = join(directory, 'output');
	const calls = join(directory, 'calls');
	writeFileSync(archive, 'original archive');
	writeFileSync(join(directory, 'skopeo'), fakeSkopeo, { mode: 0o700 });
	writeFileSync(join(directory, 'trivy'), fakeTrivy, { mode: 0o700 });

	const env = {
		...process.env,
		PATH: [directory, dirname(process.execPath), process.env.PATH].join(':'),
		FAKE_INDEX: index,
		FAKE_CALLS: calls,
		FAKE_FAIL_PLATFORM: '',
		FAKE_WRONG_ARCH: '',
		IMAGE_TAGS: 'example.invalid/fixture:verified',
		GITHUB_OUTPUT: receipt
	};
	function run(script, args, overrides) {
		return spawnSync('bash', [join(scripts, script), ...args], {
			env: { ...env, ...overrides },
			encoding: 'utf8'
		});
	}
	return {
		archive,
		calls: () => readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
		receipt: () => (existsSync(receipt) ? readFileSync(receipt, 'utf8') : ''),
		scan: (overrides) =>
			run('scan-image-archive.sh', [archive, 'linux/amd64,linux/arm64', digest], overrides),
		publish: (checksum) => run('publish-image-archive.sh', [archive, digest, checksum])
	};
}

test('scans both platform manifests before copying the verified index', (t) => {
	const image = imageFixture(t);
	const scan = image.scan();
	assert.equal(scan.status, 0, scan.stderr);

	const checkedPlatforms = image.calls().filter(([tool]) => tool === 'trivy').map((args) => {
		return args[args.indexOf('--platform') + 1];
	});
	assert.deepEqual(checkedPlatforms, ['linux/amd64', 'linux/arm64']);

	const [, checksum] = image.receipt().match(/^archive_sha256=(.+)$/m);
	const publish = image.publish(checksum);
	assert.equal(publish.status, 0, publish.stderr);
	assert.match(image.receipt(), new RegExp('^digest=' + digest + '$', 'm'));

	const registryCopies = image.calls().filter((args) => args.some((arg) => arg.startsWith('docker://')));
	assert.equal(registryCopies.length, 1);
	assert.ok(registryCopies[0].includes('--all'));
	assert.ok(registryCopies[0].includes('--preserve-digests'));
});

test('an unsuccessful arm64 scan produces no publish receipt', (t) => {
	const image = imageFixture(t);
	const scan = image.scan({ FAKE_FAIL_PLATFORM: 'linux/arm64' });
	assert.notEqual(scan.status, 0);
	assert.equal(image.receipt(), '');
	assert.equal(image.calls().filter(([tool]) => tool === 'trivy').length, 2);
});

test('a selected manifest must match the requested architecture', (t) => {
	const image = imageFixture(t);
	const scan = image.scan({ FAKE_WRONG_ARCH: 'arm64' });

	assert.notEqual(scan.status, 0);
	assert.match(scan.stderr, /selected linux\/arm64 manifest differs/);
	assert.equal(image.receipt(), '');
	const inspected = image.calls().filter(([tool]) => tool === 'trivy');
	assert.equal(inspected.length, 1);
	assert.ok(inspected[0].includes('linux/amd64'));
});

test('an archive changed after scanning cannot reach the registry copy', (t) => {
	const image = imageFixture(t);
	const scan = image.scan();
	assert.equal(scan.status, 0, scan.stderr);

	const [, checksum] = image.receipt().match(/^archive_sha256=(.+)$/m);
	writeFileSync(image.archive, 'changed archive');
	const publish = image.publish(checksum);

	assert.notEqual(publish.status, 0);
	assert.doesNotMatch(image.receipt(), /^digest=/m);
	assert.ok(!image.calls().flat().some((arg) => arg.startsWith('docker://')));
});
