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

test('authorization service build uses the fixed Go and gRPC security floors', () => {
	const dockerfile = readFileSync(
		resolve(__dirname, '../../authorization-service/Dockerfile'),
		'utf8'
	);

	// The authorization service image gate rejects Go 1.26.10 (CVE-2026-97054).
	assert.match(
		dockerfile,
		/golang:1\.26\.11-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab/
	);
	// 1.83.2, not 1.83.1: the latter fixes CVE-2026-84304 and leaves
	// CVE-2026-84445 open.
	assert.match(
		dockerfile,
		/go mod edit -require=google\.golang\.org\/grpc@v1\.83\.2/
	);
	// CVE-2026-56854, SSH authentication bypass. Arrives transitively, so the
	// override is the only thing holding the floor.
	assert.match(
		dockerfile,
		/go mod edit -require=golang\.org\/x\/crypto@v0\.55\.0/
	);
	// CVE-2026-78669, HTTP/2 SETTINGS flood DoS. The toolchain fixes the stdlib
	// copy only; the x/net module keeps its own vulnerable http2.
	assert.match(
		dockerfile,
		/go mod edit -require=golang\.org\/x\/net@v0\.62\.0/
	);
	// CVE-2026-63209. Transitive through the gRPC and Matrix client stacks, so
	// the override is the only thing holding the floor.
	assert.match(
		dockerfile,
		/go mod edit -require=github\.com\/klauspost\/compress@v1\.18\.7/
	);
});

test('gateway and authorization images declare verifiable numeric non-root users', () => {
	const gatewayDockerfile = readFileSync(
		resolve(__dirname, '../Dockerfile'),
		'utf8'
	);
	const authorizationDockerfile = readFileSync(
		resolve(__dirname, '../../authorization-service/Dockerfile'),
		'utf8'
	);

	assert.match(gatewayDockerfile, /^USER 1000:1000$/m);
	assert.match(authorizationDockerfile, /^USER 65532:65532$/m);
});

test('both image publishers attest the digest returned by the image gate', () => {
	const action = './.github/actions/docker-build-push';

	for (const path of ['ci-main.yml', 'release-image.yml']) {
		const workflow = readFileSync(resolve(__dirname, '../../.github/workflows', path), 'utf8');

		assert.equal(workflow.split(`uses: ${action}`).length - 1, 2, path);
		assert.equal((workflow.match(/push_to_ghcr: true/g) ?? []).length, 2, path);
		assert.doesNotMatch(workflow, /docker\/build-push-action@/, path);

		for (const image of ['policy_image', 'issuer_image']) {
			assert.match(workflow, new RegExp(`id: ${image}\\b`), path);
			assert.ok(workflow.includes('subject-digest: ${{ steps.' + image + '.outputs.digest }}'), path);
		}

		assert.match(workflow, /id-token: write/);
		assert.match(workflow, /attestations: write/);
		assert.match(workflow, /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/);
	}
});

test('the image gate builds one multi-platform archive before any publication', () => {
	const action = readFileSync(
		resolve(__dirname, '../../.github/actions/docker-build-push/action.yml'),
		'utf8'
	);

	assert.equal((action.match(/uses: docker\/build-push-action@/g) ?? []).length, 1);
	assert.match(action, /linux\/amd64,linux\/arm64/);
	assert.match(action, /push: false/);
	assert.match(action, /type=oci,dest=/);
	assert.match(action, /provenance: mode=max/);
	assert.match(action, /sbom: true/);
	assert.ok(action.includes('steps.publish.outputs.digest'));

	const scan = action.indexOf('scan-image-archive.sh');
	const publish = action.indexOf('publish-image-archive.sh');
	assert.ok(scan >= 0 && publish > scan, 'scan must precede publishing the archive');
});

test('pull requests validate both images without registry writes', () => {
	const workflow = readFileSync(
		resolve(__dirname, '../../.github/workflows/ci-pull-request.yml'),
		'utf8'
	);

	assert.equal((workflow.match(/push_to_ghcr: false/g) ?? []).length, 2);
	assert.doesNotMatch(workflow, /push_to_ghcr: true|packages: write|load: true/);
	assert.match(workflow, /context_dir: token-service/);
	assert.match(workflow, /context_dir: authorization-service/);
});
