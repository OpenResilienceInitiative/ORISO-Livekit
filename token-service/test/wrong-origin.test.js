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
const CALL_POLICY_URL = 'http://127.0.0.1:3040/internal/matrixrtc/call-policy';
const MATRIX_SERVER_NAME = 'matrix.oriso.org';
const MATRIX_USER_ID = `@user:${MATRIX_SERVER_NAME}`;
const ALLOWED_ORIGIN = 'https://call.oriso.org';
const MEMBERSHIP_TOKEN = 'test-membership-token';
const CALL_POLICY_TOKEN = 'test-call-policy-token';
const SOURCE_ROOM_ID = `!source:${MATRIX_SERVER_NAME}`;
const ALL_VIDEO_CALL_SOURCES = [
	'microphone',
	'camera',
	'screen_share',
	'screen_share_audio'
];

let child;
let synapse;
let upstream;
let callPolicy;
let tempDirectory;
let currentCallPolicy = { audioAllowed: true, videoAllowed: true };
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
			if (url.searchParams.get('access_token') === 'malformed-json') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end('{');
				return;
			}
			if (url.searchParams.get('access_token') !== 'valid-openid-token') {
				response.writeHead(401, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ errcode: 'M_UNAUTHORIZED' }));
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ sub: MATRIX_USER_ID }));
			return;
		}

		if (
			request.method === 'POST' &&
			url.pathname.startsWith('/_matrix/client/v3/join/')
		) {
			if (request.headers.authorization !== `Bearer ${MEMBERSHIP_TOKEN}`) {
				response.writeHead(401, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ errcode: 'M_UNAUTHORIZED' }));
				return;
			}
			if (
				url.pathname.includes(
					encodeURIComponent(`!not-invited:${MATRIX_SERVER_NAME}`)
				)
			) {
				response.writeHead(403, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ errcode: 'M_FORBIDDEN' }));
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ room_id: url.pathname.split('/').at(-1) }));
			return;
		}

		if (
			url.pathname.startsWith('/_matrix/client/v3/rooms/') &&
			url.pathname.endsWith('/joined_members')
		) {
			if (request.headers.authorization !== `Bearer ${MEMBERSHIP_TOKEN}`) {
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
			if (
				url.pathname.includes(
					encodeURIComponent(`!malformed:${MATRIX_SERVER_NAME}`)
				)
			) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end('{');
				return;
			}
			if (
				url.pathname.includes(
					encodeURIComponent(`!oversized:${MATRIX_SERVER_NAME}`)
				)
			) {
				response.writeHead(200, {
					'content-type': 'application/json',
					'content-length': '300000'
				});
				response.end('{}');
				return;
			}
			const joined = ['allowed', 'unrestricted'].some((localpart) =>
				url.pathname.includes(
					encodeURIComponent(`!${localpart}:${MATRIX_SERVER_NAME}`)
				)
			)
				? { [MATRIX_USER_ID]: { display_name: 'Test user' } }
				: {};
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ joined }));
			return;
		}

		if (
			url.pathname.startsWith('/_matrix/client/v3/rooms/') &&
			url.pathname.endsWith('/state/m.room.join_rules/')
		) {
			if (request.headers.authorization !== `Bearer ${MEMBERSHIP_TOKEN}`) {
				response.writeHead(401).end();
				return;
			}
			if (
				url.pathname.includes(
					encodeURIComponent(`!unrestricted:${MATRIX_SERVER_NAME}`)
				)
			) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ join_rule: 'invite' }));
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					join_rule: 'restricted',
					allow: [{ type: 'm.room_membership', room_id: SOURCE_ROOM_ID }]
				})
			);
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
	callPolicy = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (
			request.headers['x-matrixrtc-policy-token'] !== CALL_POLICY_TOKEN ||
			body.sourceRoomId !== SOURCE_ROOM_ID ||
			body.matrixUserId !== MATRIX_USER_ID
		) {
			response.writeHead(401).end();
			return;
		}
		if (currentCallPolicy === null) {
			response.writeHead(503).end();
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(currentCallPolicy));
	});
	await Promise.all([
		listen(synapse, 3020),
		listen(upstream, 3030),
		listen(callPolicy, 3040)
	]);

	tempDirectory = mkdtempSync(join(tmpdir(), 'matrixrtc-policy-'));
	const membershipTokenFile = join(tempDirectory, 'membership-token');
	const callPolicyTokenFile = join(tempDirectory, 'call-policy-token');
	writeFileSync(membershipTokenFile, MEMBERSHIP_TOKEN, { mode: 0o600 });
	writeFileSync(callPolicyTokenFile, CALL_POLICY_TOKEN, { mode: 0o600 });

	child = spawn(process.execPath, ['server.js'], {
		cwd: __dirname.replace(/\/test$/, ''),
		env: {
			...process.env,
			NODE_ENV: 'test',
			PORT: '3010',
			MATRIXRTC_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
			MATRIX_SERVER_NAME,
			MATRIX_FEDERATION_BASE_URL: SYNAPSE_URL,
			MATRIX_CLIENT_BASE_URL: SYNAPSE_URL,
			MATRIX_MEMBERSHIP_TOKEN_FILE: membershipTokenFile,
			MATRIXRTC_UPSTREAM_URL: UPSTREAM_URL,
			MATRIXRTC_CALL_POLICY_URL: CALL_POLICY_URL,
			MATRIXRTC_CALL_POLICY_TOKEN_FILE: callPolicyTokenFile,
			LIVEKIT_URL: 'wss://livekit.invalid'
		},
		stdio: 'ignore'
	});
	await waitUntilReady();
});

after(async () => {
	child?.kill('SIGTERM');
	await Promise.all([close(synapse), close(upstream), close(callPolicy)]);
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

test('fails closed on malformed Matrix OpenID authority JSON', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!allowed:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'malformed-json',
				matrix_server_name: MATRIX_SERVER_NAME
			}
		})
	});

	assert.equal(response.status, 503);
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

test('rejects a malformed local-looking Matrix room ID', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!bad/room:${MATRIX_SERVER_NAME}`,
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

for (const roomLocalpart of ['malformed', 'oversized']) {
	test(`fails closed on ${roomLocalpart} joined_members response`, async () => {
		const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ALLOWED_ORIGIN
			},
			body: JSON.stringify({
				room: `!${roomLocalpart}:${MATRIX_SERVER_NAME}`,
				openid_token: {
					access_token: 'valid-openid-token',
					matrix_server_name: MATRIX_SERVER_NAME
				}
			})
		});

		assert.equal(response.status, 503);
	});
}

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
		},
		permissions: { roomAdmin: true },
		identity: 'attacker-selected-identity'
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
			body: {
				room_id: requestBody.room_id,
				slot_id: requestBody.slot_id,
				openid_token: {
					access_token: requestBody.openid_token.access_token,
					matrix_server_name:
						requestBody.openid_token.matrix_server_name
				},
				member: requestBody.member,
				...(path === 'get_token'
					? { allowed_publish_sources: ALL_VIDEO_CALL_SOURCES }
					: {})
			}
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
		body: {
			room: requestBody.room,
			openid_token: {
				access_token: requestBody.openid_token.access_token,
				matrix_server_name:
					requestBody.openid_token.matrix_server_name
			},
			device_id: requestBody.device_id,
			allowed_publish_sources: ALL_VIDEO_CALL_SOURCES
		}
	});
});

test('restricts an audio-only tenant grant to microphone publication', async () => {
	const previousRequestCount = upstreamRequests.length;
	currentCallPolicy = { audioAllowed: true, videoAllowed: false };
	try {
		const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ALLOWED_ORIGIN
			},
			body: JSON.stringify({
				room: `!allowed:${MATRIX_SERVER_NAME}`,
				openid_token: {
					access_token: 'valid-openid-token',
					matrix_server_name: MATRIX_SERVER_NAME
				},
				device_id: 'ORISO_WEB_TEST'
			})
		});

		assert.equal(response.status, 200);
		assert.equal(upstreamRequests.length, previousRequestCount + 1);
		assert.deepEqual(upstreamRequests.at(-1).body.allowed_publish_sources, [
			'microphone'
		]);
	} finally {
		currentCallPolicy = { audioAllowed: true, videoAllowed: true };
	}
});

test('denies token issuance when current tenant call permissions are off', async () => {
	const previousRequestCount = upstreamRequests.length;
	currentCallPolicy = { audioAllowed: false, videoAllowed: false };
	try {
		const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ALLOWED_ORIGIN
			},
			body: JSON.stringify({
				room: `!allowed:${MATRIX_SERVER_NAME}`,
				openid_token: {
					access_token: 'valid-openid-token',
					matrix_server_name: MATRIX_SERVER_NAME
				}
			})
		});

		assert.equal(response.status, 403);
		assert.equal(upstreamRequests.length, previousRequestCount);
	} finally {
		currentCallPolicy = { audioAllowed: true, videoAllowed: true };
	}
});

test('denies a call room without one restricted ORISO source room', async () => {
	const previousRequestCount = upstreamRequests.length;
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!unrestricted:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'valid-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			}
		})
	});

	assert.equal(response.status, 403);
	assert.equal(upstreamRequests.length, previousRequestCount);
});

test('rejects a valid identity absent from joined_members, including leave or ban states', async () => {
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

test('rejects a call room that did not invite the scoped membership reader', async () => {
	const response = await fetch(`${SERVICE_URL}/livekit/jwt/sfu/get`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ALLOWED_ORIGIN
		},
		body: JSON.stringify({
			room: `!not-invited:${MATRIX_SERVER_NAME}`,
			openid_token: {
				access_token: 'valid-openid-token',
				matrix_server_name: MATRIX_SERVER_NAME
			}
		})
	});

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: 'forbidden' });
});
