const express = require('express');
const helmet = require('helmet');
const { readFileSync } = require('node:fs');

const PORT = Number.parseInt(process.env.PORT || '3010', 10);
const MATRIX_SERVER_NAME = process.env.MATRIX_SERVER_NAME?.trim();
const MATRIX_FEDERATION_BASE_URL =
	process.env.MATRIX_FEDERATION_BASE_URL?.trim();
const MATRIX_CLIENT_BASE_URL = process.env.MATRIX_CLIENT_BASE_URL?.trim();
const MATRIX_MEMBERSHIP_TOKEN_FILE =
	process.env.MATRIX_MEMBERSHIP_TOKEN_FILE?.trim();
const MATRIXRTC_UPSTREAM_URL = process.env.MATRIXRTC_UPSTREAM_URL?.trim();
const MATRIXRTC_CALL_POLICY_URL =
	process.env.MATRIXRTC_CALL_POLICY_URL?.trim();
const MATRIXRTC_CALL_POLICY_TOKEN_FILE =
	process.env.MATRIXRTC_CALL_POLICY_TOKEN_FILE?.trim();
const REQUEST_TIMEOUT_MS = Number.parseInt(
	process.env.MATRIXRTC_REQUEST_TIMEOUT_MS || '8000',
	10
);
const MAX_AUTHORITY_RESPONSE_BYTES = Number.parseInt(
	process.env.MATRIXRTC_MAX_AUTHORITY_RESPONSE_BYTES || '262144',
	10
);
const RATE_LIMIT_WINDOW_MS = Number.parseInt(
	process.env.MATRIXRTC_RATE_LIMIT_WINDOW_MS || '60000',
	10
);
const RATE_LIMIT_MAX_REQUESTS = Number.parseInt(
	process.env.MATRIXRTC_RATE_LIMIT_MAX_REQUESTS || '120',
	10
);

const parseAllowedOrigins = (value) => {
	const origins = new Set();
	for (const rawOrigin of (value || '').split(',')) {
		const candidate = rawOrigin.trim();
		if (!candidate) continue;
		const url = new URL(candidate);
		if (url.protocol !== 'https:' || url.origin !== candidate) {
			throw new Error('MATRIXRTC_ALLOWED_ORIGINS must contain exact HTTPS origins');
		}
		origins.add(candidate);
	}
	return origins;
};

const requireSecureMatrixUrl = (value, name) => {
	if (!value) throw new Error(`${name} must be configured`);
	const url = new URL(value);
	const isLoopbackTestUrl =
		url.protocol === 'http:' &&
		(url.hostname === '127.0.0.1' || url.hostname === '::1') &&
		process.env.NODE_ENV === 'test';
	if (url.protocol !== 'https:' && !isLoopbackTestUrl) {
		throw new Error(`${name} must use HTTPS`);
	}
	return url;
};

const ALLOWED_ORIGINS = parseAllowedOrigins(
	process.env.MATRIXRTC_ALLOWED_ORIGINS
);
if (ALLOWED_ORIGINS.size === 0) {
	throw new Error('MATRIXRTC_ALLOWED_ORIGINS must be configured');
}
if (
	!MATRIX_SERVER_NAME ||
	!MATRIX_MEMBERSHIP_TOKEN_FILE ||
	!MATRIXRTC_UPSTREAM_URL ||
	!MATRIXRTC_CALL_POLICY_URL ||
	!MATRIXRTC_CALL_POLICY_TOKEN_FILE
) {
	throw new Error('Matrix authorization configuration is incomplete');
}

const FEDERATION_BASE_URL = requireSecureMatrixUrl(
	MATRIX_FEDERATION_BASE_URL,
	'MATRIX_FEDERATION_BASE_URL'
);
const CLIENT_BASE_URL = requireSecureMatrixUrl(
	MATRIX_CLIENT_BASE_URL,
	'MATRIX_CLIENT_BASE_URL'
);
const UPSTREAM_BASE_URL = new URL(MATRIXRTC_UPSTREAM_URL);
const CALL_POLICY_URL = new URL(MATRIXRTC_CALL_POLICY_URL);

const MATRIX_MEMBERSHIP_TOKEN = readFileSync(
	MATRIX_MEMBERSHIP_TOKEN_FILE,
	'utf8'
).trim();
if (!MATRIX_MEMBERSHIP_TOKEN) {
	throw new Error('Matrix membership token file is empty');
}
const MATRIXRTC_CALL_POLICY_TOKEN = readFileSync(
	MATRIXRTC_CALL_POLICY_TOKEN_FILE,
	'utf8'
).trim();
if (!MATRIXRTC_CALL_POLICY_TOKEN) {
	throw new Error('MatrixRTC call policy token file is empty');
}

const escapeRegExp = (value) =>
	value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROOM_ID_PATTERN = new RegExp(
	`^![A-Za-z0-9._~=-]+:${escapeRegExp(MATRIX_SERVER_NAME)}$`
);
const LOCAL_USER_ID_SUFFIX = `:${MATRIX_SERVER_NAME}`;
const ALL_VIDEO_CALL_SOURCES = [
	'microphone',
	'camera',
	'screen_share',
	'screen_share_audio'
];

const readBodyLimited = async (response, maxBytes) => {
	const advertisedLength = Number.parseInt(
		response.headers.get('content-length') || '0',
		10
	);
	if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
		throw new Error('authority response too large');
	}

	const chunks = [];
	let bytesRead = 0;
	for await (const chunk of response.body) {
		bytesRead += chunk.byteLength;
		if (bytesRead > maxBytes) {
			throw new Error('authority response too large');
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
};

const readJsonLimited = async (response) =>
	JSON.parse(
		await readBodyLimited(response, MAX_AUTHORITY_RESPONSE_BYTES)
	);

const sanitizeOpenIdToken = (token) => ({
	access_token: token.access_token,
	token_type: token.token_type,
	matrix_server_name: token.matrix_server_name,
	expires_in: token.expires_in
});

const sanitizeMember = (member) => ({
	id: member.id,
	claimed_user_id: member.claimed_user_id,
	claimed_device_id: member.claimed_device_id
});

const sanitizeUpstreamBody = (path, body) => {
	if (path === '/sfu/get') {
		return {
			room: body.room,
			openid_token: sanitizeOpenIdToken(body.openid_token),
			device_id: body.device_id,
			delay_id: body.delay_id,
			delay_timeout: body.delay_timeout,
			allowed_publish_sources: body.allowed_publish_sources
		};
	}

	const sanitized = {
		room_id: body.room_id,
		slot_id: body.slot_id,
		openid_token: sanitizeOpenIdToken(body.openid_token),
		member: sanitizeMember(body.member),
		delay_id: body.delay_id,
		delay_timeout: body.delay_timeout,
		allowed_publish_sources: body.allowed_publish_sources
	};
	if (path === '/delegate_delayed_leave') {
		return sanitized;
	}
	return sanitized;
};

const sourceRoomFromJoinRule = (joinRule) => {
	if (joinRule?.join_rule !== 'restricted' || !Array.isArray(joinRule.allow)) {
		return null;
	}
	const sourceRooms = joinRule.allow
		.filter((entry) => entry?.type === 'm.room_membership')
		.map((entry) => entry.room_id)
		.filter((roomId) => typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId));
	return sourceRooms.length === 1 ? sourceRooms[0] : null;
};

const createRateLimiter = () => {
	const clients = new Map();
	return (req, res, next) => {
		const now = Date.now();
		const key = req.ip;
		const current = clients.get(key);
		if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
			clients.set(key, { count: 1, startedAt: now });
			return next();
		}
		current.count += 1;
		if (current.count > RATE_LIMIT_MAX_REQUESTS) {
			res.set('retry-after', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
			return res.status(429).json({ error: 'rate limit exceeded' });
		}
		return next();
	};
};

const app = express();
app.disable('x-powered-by');
app.use(
	helmet({
		contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } }
	})
);
app.use(express.json({ limit: '16kb', strict: true }));

app.get('/health', (_req, res) => {
	res.json({ status: 'ok', service: 'matrixrtc-auth-policy-gateway' });
});
app.get('/livekit/jwt/health', (_req, res) => {
	res.json({ status: 'ok', service: 'matrixrtc-auth-policy-gateway' });
});

app.use('/livekit/jwt', (req, res, next) => {
	const origin = req.get('origin');
	if (!origin || !ALLOWED_ORIGINS.has(origin)) {
		return res.status(403).json({ error: 'forbidden' });
	}
	res.set({
		'access-control-allow-origin': origin,
		'access-control-allow-methods': 'POST, OPTIONS',
		'access-control-allow-headers': 'content-type',
		vary: 'Origin'
	});
	if (req.method === 'OPTIONS') return res.sendStatus(204);
	return next();
});

app.use('/livekit/jwt', createRateLimiter());

app.use('/livekit/jwt', async (req, res, next) => {
	const room = req.body?.room || req.body?.room_id;
	const openIdToken = req.body?.openid_token;
	if (
		typeof room !== 'string' ||
		!ROOM_ID_PATTERN.test(room) ||
		typeof openIdToken?.access_token !== 'string' ||
		openIdToken.access_token.length < 1 ||
		openIdToken.access_token.length > 4096 ||
		openIdToken.matrix_server_name !== MATRIX_SERVER_NAME
	) {
		return res.status(403).json({ error: 'forbidden' });
	}

	const deadline = new AbortController();
	const deadlineTimer = setTimeout(
		() => deadline.abort(),
		REQUEST_TIMEOUT_MS
	);
	res.on('close', () => {
		clearTimeout(deadlineTimer);
		deadline.abort();
	});
	req.authorizationSignal = deadline.signal;
	req.authorizationDeadlineTimer = deadlineTimer;

	const userInfoUrl = new URL(
		'/_matrix/federation/v1/openid/userinfo',
		FEDERATION_BASE_URL
	);
	userInfoUrl.searchParams.set('access_token', openIdToken.access_token);

	let userInfoResponse;
	try {
		userInfoResponse = await fetch(userInfoUrl, {
			signal: deadline.signal
		});
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!userInfoResponse.ok) {
		clearTimeout(deadlineTimer);
		console.warn(
			JSON.stringify({
				event: 'matrixrtc_authorization_denied',
				reason: 'openid_authority_rejected'
			})
		);
		return res.status(401).json({ error: 'unauthorized' });
	}

	let userInfo;
	try {
		userInfo = await readJsonLimited(userInfoResponse);
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	const matrixUserId = userInfo?.sub;
	if (
		typeof matrixUserId !== 'string' ||
		!matrixUserId.endsWith(LOCAL_USER_ID_SUFFIX) ||
		(req.body?.member?.claimed_user_id &&
			req.body.member.claimed_user_id !== matrixUserId)
	) {
		clearTimeout(deadlineTimer);
		console.warn(
			JSON.stringify({
				event: 'matrixrtc_authorization_denied',
				reason: 'openid_subject_scope_mismatch'
			})
		);
		return res.status(401).json({ error: 'unauthorized' });
	}

	const joinedMembersUrl = new URL(
		`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`,
		CLIENT_BASE_URL
	);
	const joinRoomUrl = new URL(
		`/_matrix/client/v3/join/${encodeURIComponent(room)}`,
		CLIENT_BASE_URL
	);
	let joinedMembersResponse;
	try {
		const joinResponse = await fetch(joinRoomUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${MATRIX_MEMBERSHIP_TOKEN}`,
				'content-type': 'application/json'
			},
			body: '{}',
			signal: deadline.signal
		});
		if (!joinResponse.ok) {
			clearTimeout(deadlineTimer);
			return res.status(403).json({ error: 'forbidden' });
		}
		joinedMembersResponse = await fetch(joinedMembersUrl, {
			headers: {
				authorization: `Bearer ${MATRIX_MEMBERSHIP_TOKEN}`
			},
			signal: deadline.signal
		});
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!joinedMembersResponse.ok) {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}

	let membership;
	try {
		membership = await readJsonLimited(joinedMembersResponse);
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (
		typeof membership?.joined !== 'object' ||
		membership.joined === null ||
		!Object.hasOwn(membership.joined, matrixUserId)
	) {
		clearTimeout(deadlineTimer);
		return res.status(403).json({ error: 'forbidden' });
	}

	if (req.path === '/delegate_delayed_leave') {
		return next();
	}

	const joinRuleUrl = new URL(
		`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.join_rules/`,
		CLIENT_BASE_URL
	);
	let joinRuleResponse;
	try {
		joinRuleResponse = await fetch(joinRuleUrl, {
			headers: {
				authorization: `Bearer ${MATRIX_MEMBERSHIP_TOKEN}`
			},
			signal: deadline.signal
		});
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!joinRuleResponse.ok) {
		clearTimeout(deadlineTimer);
		return res.status(403).json({ error: 'forbidden' });
	}

	let sourceRoomId;
	try {
		sourceRoomId = sourceRoomFromJoinRule(
			await readJsonLimited(joinRuleResponse)
		);
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!sourceRoomId) {
		clearTimeout(deadlineTimer);
		return res.status(403).json({ error: 'forbidden' });
	}

	let callPolicyResponse;
	try {
		callPolicyResponse = await fetch(CALL_POLICY_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-matrixrtc-policy-token': MATRIXRTC_CALL_POLICY_TOKEN
			},
			body: JSON.stringify({ sourceRoomId, matrixUserId }),
			signal: deadline.signal
		});
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!callPolicyResponse.ok) {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}

	let callPolicy;
	try {
		callPolicy = await readJsonLimited(callPolicyResponse);
	} catch {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (
		typeof callPolicy?.audioAllowed !== 'boolean' ||
		typeof callPolicy?.videoAllowed !== 'boolean'
	) {
		clearTimeout(deadlineTimer);
		return res.status(503).json({ error: 'authorization unavailable' });
	}
	if (!callPolicy.audioAllowed && !callPolicy.videoAllowed) {
		clearTimeout(deadlineTimer);
		return res.status(403).json({ error: 'forbidden' });
	}

	req.body.allowed_publish_sources = callPolicy.videoAllowed
		? ALL_VIDEO_CALL_SOURCES
		: ['microphone'];

	return next();
});

async function proxyToAuthorizationService(req, res, upstreamPath) {
	let upstreamResponse;
	try {
		upstreamResponse = await fetch(
			new URL(upstreamPath, UPSTREAM_BASE_URL),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					sanitizeUpstreamBody(upstreamPath, req.body)
				),
				signal: req.authorizationSignal
			}
		);
	} catch {
		clearTimeout(req.authorizationDeadlineTimer);
		return res.status(502).json({ error: 'authorization service unavailable' });
	}

	let responseBody;
	try {
		responseBody = await readBodyLimited(
			upstreamResponse,
			MAX_AUTHORITY_RESPONSE_BYTES
		);
	} catch {
		clearTimeout(req.authorizationDeadlineTimer);
		return res.status(502).json({ error: 'authorization service unavailable' });
	}
	clearTimeout(req.authorizationDeadlineTimer);
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
