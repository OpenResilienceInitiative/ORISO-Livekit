const SWEEP_INTERVAL_MS = 1000;
const SWEEP_BATCH_SIZE = 512;

const createRateLimiter = (windowMs, maxRequests) => {
	const clients = new Map();
	// Bound each pass at its start so new clients cannot keep it open.
	let sweepCursor;
	let sweepRemaining = 0;
	const sweep = setInterval(() => {
		const now = Date.now();
		if (sweepRemaining === 0) {
			sweepCursor = clients.entries();
			sweepRemaining = clients.size;
		}
		for (let i = 0; i < SWEEP_BATCH_SIZE && sweepRemaining > 0; i += 1) {
			const entry = sweepCursor.next();
			if (entry.done) {
				sweepRemaining = 0;
				break;
			}
			sweepRemaining -= 1;
			const [key, bucket] = entry.value;
			if (now - bucket.startedAt >= windowMs) {
				clients.delete(key);
			}
		}
	}, SWEEP_INTERVAL_MS);
	sweep.unref();

	return (req, res, next) => {
		const now = Date.now();
		const key = req.ip;
		const current = clients.get(key);
		if (!current || now - current.startedAt >= windowMs) {
			clients.set(key, { count: 1, startedAt: now });
			return next();
		}
		current.count += 1;
		if (current.count > maxRequests) {
			res.set('retry-after', String(Math.ceil(windowMs / 1000)));
			return res.status(429).json({ error: 'rate limit exceeded' });
		}
		return next();
	};
};

module.exports = { createRateLimiter };
