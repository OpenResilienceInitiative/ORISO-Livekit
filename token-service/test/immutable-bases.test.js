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

	assert.match(
		dockerfile,
		/golang:1\.26\.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2/
	);
	assert.match(
		dockerfile,
		/go mod edit -require=google\.golang\.org\/grpc@v1\.82\.1/
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

test('release workflow publishes immutable multi-platform images with evidence', () => {
	const buildAction = readFileSync(
		resolve(__dirname, '../../.github/actions/docker-build-push/action.yml'),
		'utf8'
	);
	const mainWorkflow = readFileSync(
		resolve(__dirname, '../../.github/workflows/ci-main.yml'),
		'utf8'
	);

	assert.match(buildAction, /linux\/amd64,linux\/arm64/);
	assert.match(buildAction, /provenance: mode=max/);
	assert.match(buildAction, /sbom: true/);
	assert.match(buildAction, /value: \$\{\{ steps\.build\.outputs\.digest \}\}/);
	assert.match(mainWorkflow, /id-token: write/);
	assert.match(mainWorkflow, /attestations: write/);
	assert.match(
		mainWorkflow,
		/aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/
	);
	assert.match(
		mainWorkflow,
		/actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/
	);
	assert.match(
		mainWorkflow,
		/image-ref: .*@\$\{\{ steps\..*\.outputs\.digest \}\}/
	);
	assert.equal(
		(mainWorkflow.match(/subject-digest: \$\{\{ steps\./g) ?? []).length,
		2
	);
});
