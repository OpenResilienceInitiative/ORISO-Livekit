const express = require('express');
const cors = require('cors');
const { readFileSync } = require('node:fs');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3010', 10);
const ALLOWED_ORIGINS = new Set(
	(process.env.MATRIXRTC_ALLOWED_ORIGINS || '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean)
);
const MATRIX_SERVER_NAME = process.env.MATRIX_SERVER_NAME?.trim();
const MATRIX_FEDERATION_BASE_URL =
	process.env.MATRIX_FEDERATION_BASE_URL?.trim();
const MATRIX_ADMIN_BASE_URL = process.env.MATRIX_ADMIN_BASE_URL?.trim();
const MATRIX_ADMIN_TOKEN_FILE = process.env.MATRIX_ADMIN_TOKEN_FILE?.trim();
const MATRIXRTC_UPSTREAM_URL = process.env.MATRIXRTC_UPSTREAM_URL?.trim();
const UPSTREAM_TIMEOUT_MS = Number.parseInt(
	process.env.MATRIXRTC_UPSTREAM_TIMEOUT_MS || '5000',
	10
);

if (ALLOWED_ORIGINS.size === 0) {
	throw new Error('MATRIXRTC_ALLOWED_ORIGINS must be configured');
}
if (
	!MATRIX_SERVER_NAME ||
	!MATRIX_FEDERATION_BASE_URL ||
	!MATRIX_ADMIN_BASE_URL ||
	!MATRIX_ADMIN_TOKEN_FILE ||
	!MATRIXRTC_UPSTREAM_URL
) {
	throw new Error('Matrix authorization configuration is incomplete');
}

const MATRIX_ADMIN_TOKEN = readFileSync(
	MATRIX_ADMIN_TOKEN_FILE,
	'utf8'
).trim();
if (!MATRIX_ADMIN_TOKEN) {
	throw new Error('Matrix admin token file is empty');
}

app.use(
	cors({
		origin(origin, callback) {
			callback(null, !!origin && ALLOWED_ORIGINS.has(origin));
		}
	})
);
app.use(express.json({ limit: '16kb', strict: true }));

app.use((req, res, next) => {
	if (
		req.path.startsWith('/livekit/jwt/') &&
		!ALLOWED_ORIGINS.has(req.get('origin'))
	) {
		return res.status(403).json({ error: 'forbidden' });
	}
	return next();
});

app.use('/livekit/jwt', async (req, res, next) => {
	const room = req.body?.room || req.body?.room_id;
	const openIdToken = req.body?.openid_token;
	const roomServerName =
		typeof room === 'string' && room.startsWith('!')
			? room.slice(room.indexOf(':') + 1)
			: undefined;
	if (
		typeof room !== 'string' ||
		roomServerName !== MATRIX_SERVER_NAME ||
		typeof openIdToken?.access_token !== 'string' ||
		openIdToken.matrix_server_name !== MATRIX_SERVER_NAME
	) {
		return res.status(403).json({ error: 'forbidden' });
	}

	const userInfoUrl = new URL(
		'/_matrix/federation/v1/openid/userinfo',
		MATRIX_FEDERATION_BASE_URL
	);
	userInfoUrl.searchParams.set('access_token', openIdToken.access_token);

	let userInfoResponse;
	try {
		userInfoResponse = await fetch(userInfoUrl, {
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
	} catch {
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!userInfoResponse.ok) {
		return res.status(401).json({ error: 'unauthorized' });
	}

	let userInfo;
	try {
		userInfo = await userInfoResponse.json();
	} catch {
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	const matrixUserId = userInfo?.sub;
	if (
		typeof matrixUserId !== 'string' ||
		!matrixUserId.endsWith(`:${MATRIX_SERVER_NAME}`) ||
		(req.body?.member?.claimed_user_id &&
			req.body.member.claimed_user_id !== matrixUserId)
	) {
		return res.status(401).json({ error: 'unauthorized' });
	}

	const membersUrl = new URL(
		`/_synapse/admin/v1/rooms/${encodeURIComponent(room)}/members`,
		MATRIX_ADMIN_BASE_URL
	);
	let membersResponse;
	try {
		membersResponse = await fetch(membersUrl, {
			headers: {
				authorization: `Bearer ${MATRIX_ADMIN_TOKEN}`
			},
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
	} catch {
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!membersResponse.ok) {
		return res.status(503).json({ error: 'authorization unavailable' });
	}

	let membership;
	try {
		membership = await membersResponse.json();
	} catch {
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (
		!Array.isArray(membership?.members) ||
		!membership.members.includes(matrixUserId)
	) {
		return res.status(403).json({ error: 'forbidden' });
	}

	return next();
});

app.get('/health', (_req, res) => {
	res.json({ status: 'ok', service: 'matrixrtc-auth-policy-gateway' });
});

async function proxyToAuthorizationService(req, res, upstreamPath) {
	let upstreamResponse;
	try {
		upstreamResponse = await fetch(
			new URL(upstreamPath, MATRIXRTC_UPSTREAM_URL),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(req.body),
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
			}
		);
	} catch {
		return res.status(502).json({ error: 'authorization service unavailable' });
	}

	const responseBody = await upstreamResponse.text();
	res.status(upstreamResponse.status);
	const contentType = upstreamResponse.headers.get('content-type');
	if (contentType) res.type(contentType);
	return res.send(responseBody);
}

app.post('/livekit/jwt/sfu/get', (req, res) =>
	proxyToAuthorizationService(req, res, '/sfu/get')
);
app.post('/livekit/jwt/get_token', (req, res) =>
	proxyToAuthorizationService(req, res, '/get_token')
);
app.post('/livekit/jwt/delegate_delayed_leave', (req, res) =>
	proxyToAuthorizationService(req, res, '/delegate_delayed_leave')
);

app.use((error, _req, res, next) => {
	if (
		error?.type === 'entity.too.large' ||
		(error instanceof SyntaxError && error.status === 400)
	) {
		return res.status(error.status || 400).json({ error: 'invalid request' });
	}
	return next(error);
});

app.listen(PORT, () => {
	console.log(`MatrixRTC authorization policy gateway listening on port ${PORT}`);
});
