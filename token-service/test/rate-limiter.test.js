const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRateLimiter } = require('../rate-limiter');

const fixture = (t, windowMs = 1000, maxRequests = 2) => {
	let now = 0;
	let unrefCalls = 0;
	const sweeps = [];
	const expired = [];
	const mapDelete = Map.prototype.delete;

	t.mock.method(Date, 'now', () => now);
	t.mock.method(globalThis, 'setInterval', (callback) => {
		sweeps.push(callback);
		return {
			unref() {
				unrefCalls += 1;
			}
		};
	});
	t.mock.method(Map.prototype, 'delete', function (key) {
		const removed = mapDelete.call(this, key);
		if (removed && typeof key === 'string' && key.startsWith('client-')) {
			expired.push(key);
		}
		return removed;
	});

	const limiter = createRateLimiter(windowMs, maxRequests);
	return {
		expired,
		setTime(value) {
			now = value;
		},
		sweep() {
			assert.equal(sweeps.length, 1, 'Expected one cleanup timer');
			assert.equal(unrefCalls, 1, 'The timer must not keep the process alive');
			sweeps[0]();
		},
		request(ip) {
			const result = { allowed: false, headers: {} };
			const res = {
				set(name, value) {
					result.headers[name] = value;
				},
				status(statusCode) {
					result.statusCode = statusCode;
					return this;
				},
				json(body) {
					result.body = body;
				}
			};
			limiter({ ip }, res, () => {
				result.allowed = true;
			});
			return result;
		}
	};
};

test('cleans up expired windows during idle periods and retains active windows', (t) => {
	const limiter = fixture(t);
	limiter.request('client-first');
	limiter.setTime(500);
	limiter.request('client-second');

	limiter.setTime(1000);
	limiter.sweep();
	assert.deepEqual(limiter.expired, ['client-first']);
	limiter.setTime(1500);
	limiter.sweep();
	assert.deepEqual(limiter.expired, ['client-first', 'client-second']);
});

test('keeps the active quota, retry response and independent client windows', (t) => {
	const limiter = fixture(t, 60_000);
	assert.equal(limiter.request('client-first').allowed, true);
	assert.equal(limiter.request('client-first').allowed, true);
	assert.equal(limiter.request('client-second').allowed, true);

	limiter.setTime(59_999);
	limiter.sweep();
	assert.deepEqual(limiter.request('client-first'), {
		allowed: false,
		headers: { 'retry-after': '60' },
		statusCode: 429,
		body: { error: 'rate limit exceeded' }
	});
	limiter.setTime(60_000);
	assert.equal(limiter.request('client-first').allowed, true);
});

test('limits the work per sweep and resumes cleanup on a later tick', (t) => {
	const limiter = fixture(t);
	for (let i = 0; i < 513; i += 1) {
		limiter.request(`client-${i}`);
	}

	limiter.setTime(1000);
	limiter.sweep();
	assert.equal(limiter.expired.length, 512);
	limiter.setTime(2000);
	limiter.sweep();
	assert.equal(limiter.expired.length, 513);
});

test('revisits earlier windows even while new windows are being added', (t) => {
	const limiter = fixture(t);
	limiter.request('client-original');
	for (let i = 0; i < 512; i += 1) {
		limiter.request(`client-first-${i}`);
	}
	limiter.setTime(500);
	limiter.sweep();
	assert.deepEqual(limiter.expired, []);

	for (const [now, group] of [[1200, 'next'], [1300, 'later']]) {
		limiter.setTime(now);
		for (let i = 0; i < 513; i += 1) {
			limiter.request(`client-${group}-${i}`);
		}
		limiter.sweep();
	}
	assert.ok(limiter.expired.includes('client-original'));
});
