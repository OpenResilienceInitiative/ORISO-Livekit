const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_URL = 'http://127.0.0.1:3010';
const SYNAPSE_URL = 'http://127.0.0.1:3020';
const UPSTREAM_URL = 'http://127.0.0.1:3030';
const MATRIX_SERVER_NAME = 'matrix.oriso.org';
const MATRIX_USER_ID = `@user:${MATRIX_SERVER_NAME}`;
const ALLOWED_ORIGIN = 'https://call.oriso.org';
const ADMIN_TOKEN = 'test-admin-token';

let child;
let synapse;
let upstream;
let tempDirectory;
const upstreamRequests = [];

const listen = (server, port) =>
	new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const close = (server) =>
	new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);

const waitUntilReady = async () => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const response = await fetch(`${SERVICE_URL}/health`);
			if (response.ok) return;
		} catch {
			// The child process has not bound its port yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('policy gateway did not become ready');
};

before(async () => {
	synapse = createServer((request, response) => {
		const url = new URL(request.url, SYNAPSE_URL);
		if (url.pathname === '/_matrix/federation/v1/openid/userinfo') {
			if (url.searchParams.get('access_token') !== 'valid-openid-token') {
				response.writeHead(401, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ errcode: 'M_UNAUTHORIZED' }));
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ sub: MATRIX_USER_ID }));
			return;
		}

		if (url.pathname.startsWith('/_synapse/admin/v1/rooms/')) {
			if (request.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
				response.writeHead(401, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ errcode: 'M_UNAUTHORIZED' }));
				return;
			}
			if (
				url.pathname.includes(
					encodeURIComponent(`!unavailable:${MATRIX_SERVER_NAME}`)
				)
			) {
				response.writeHead(500, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ errcode: 'M_UNKNOWN' }));
				return;
			}
			const members = url.pathname.includes(
				encodeURIComponent(`!allowed:${MATRIX_SERVER_NAME}`)
			)
				? [MATRIX_USER_ID]
				: [];
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ members, total: members.length }));
			return;
		}

		response.writeHead(404).end();
	});
	upstream = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		upstreamRequests.push({
			method: request.method,
			url: request.url,
			body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
		});
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				url: 'wss://livekit.oriso.org',
				jwt: 'test-livekit-jwt'
			})
		);
	});
	await Promise.all([
		listen(synapse, 3020),
		listen(upstream, 3030)
	]);

	tempDirectory = mkdtempSync(join(tmpdir(), 'matrixrtc-policy-'));
	const adminTokenFile = join(tempDirectory, 'admin-token');
	writeFileSync(adminTokenFile, ADMIN_TOKEN, { mode: 0o600 });

	child = spawn(process.execPath, ['server.js'], {
		cwd: __dirname.replace(/\/test$/, ''),
		env: {
			...process.env,
			PORT: '3010',
			MATRIXRTC_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
			MATRIX_SERVER_NAME,
			MATRIX_FEDERATION_BASE_URL: SYNAPSE_URL,
			MATRIX_ADMIN_BASE_URL: SYNAPSE_URL,
			MATRIX_ADMIN_TOKEN_FILE: adminTokenFile,
			MATRIXRTC_UPSTREAM_URL: UPSTREAM_URL,
			LIVEKIT_URL: 'wss://livekit.invalid'
		},
		stdio: 'ignore'
	});
	await waitUntilReady();
});

after(async () => {
	child?.kill('SIGTERM');
	await Promise.all([close(synapse), close(upstream)]);
	rmSync(tempDirectory, { recursive: true, force: true });
});

test('rejects a token request from an origin outside the Element Call allowlist', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: 'https://attacker.example'
		},
		body: JSON.stringify({
			room: '!call:matrix.oriso.org',
			openid_token: {
				access_token: 'test-openid-token',
				matrix_server_name: 'matrix.oriso.org'
			},
			device_id: 'ORISO_WEB_TEST'
		})
	});

	assert.equal(response.status, 403);
});

test('rejects an invalid or expired Matrix OpenID token', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!allowed:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'expired-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			}
		})
	});

	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('rejects a room on another Matrix homeserver', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: '!allowed:attacker.example',
			openid_token: {
				access_token: 'valid-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			}
		})
	});

	assert.equal(response.status, 403);
});

test('rejects a spoofed claimed Matrix user', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/get_token`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room_id: `!allowed:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'valid-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			},
			member: {
				claimed_user_id: `@attacker:${MATRIX_SERVER_NAME}`
			}
		})
	});

	assert.equal(response.status, 401);
});

test('fails closed when the room-membership authority is unavailable', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!unavailable:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'valid-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			}
		})
	});

	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		error: 'authorization unavailable'
	});
});

test('maps current MatrixRTC authorization routes to the internal service', async () => {
	const requestBody = {
		room_id: `!allowed:${MATRIX_SERVER_NAME}`,
		slot_id: 'm.call#',
		openid_token: {
			access_token: 'valid-openid-token',
			matrix_server_name: MATRIX_SERVER_NAME
		},
		member: {
			id: 'member-1',
			claimed_user_id: MATRIX_USER_ID,
			claimed_device_id: 'ORISO_WEB_TEST'
		}
	};

	for (const path of ['get_token', 'delegate_delayed_leave']) {
		const previousRequestCount = upstreamRequests.length;
		const response = await fetch(`${SERVICE_URL}/livekit/jwt/${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ALLOWED_ORIGIN
			},
			body: JSON.stringify(requestBody)
		});

		assert.equal(response.status, 200);
		assert.equal(upstreamRequests.length, previousRequestCount + 1);
		assert.deepEqual(upstreamRequests.at(-1), {
			method: 'POST',
			url: `/${path}`,
			body: requestBody
		});
	}
});

test('physically removes the unauthenticated legacy token endpoint', async () => {
	const response = await fetch(
		`${SERVICE_URL}/api/livekit/token?roomName=room&identity=user`
	);

	assert.equal(response.status, 404);
});

test('proxies an authorized joined member to the canonical JWT service', async () => {
	const requestBody = {
		room: `!allowed:${MATRIX_SERVER_NAME}`,
		openid_token: {
			access_token: 'valid-openid-token',
			matrix_server_name: MATRIX_SERVER_NAME
		},
		device_id: 'ORISO_WEB_TEST'
	};
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify(requestBody)
	});

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		url: 'wss://livekit.oriso.org',
		jwt: 'test-livekit-jwt'
	});
	assert.deepEqual(upstreamRequests.at(-1), {
		method: 'POST',
		url: '/sfu/get',
		body: requestBody
	});
});

test('rejects a valid Matrix identity that is not joined to the requested call room', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!denied:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'valid-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			},
			device_id: 'ORISO_WEB_TEST'
		})
	});

	assert.equal(response.status, 403);
});
