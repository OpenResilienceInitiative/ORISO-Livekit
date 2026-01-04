const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const PORT = 3010;

// LiveKit credentials
const LIVEKIT_API_KEY = 'APIm7qGJ8kR3fN2pL5tX';
const LIVEKIT_API_SECRET = 'secretW9vY4bH6nK8mP2qR7sT3xZ5A1B2C3D4E5F6G7H8';

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'livekit-token-service' });
});

// Generate LiveKit token (GET with query params) - for direct calls
app.get('/api/livekit/token', async (req, res) => {
    try {
        const { roomName, identity } = req.query;

        if (!roomName || !identity) {
            return res.status(400).json({ error: 'roomName and identity are required' });
        }

        console.log(`Generating token for user: ${identity}, room: ${roomName}`);

        // Create access token
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: identity,
            name: identity,
        });

        // Add grant for the room
        at.addGrant({
            room: roomName,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
        });

        const token = await at.toJwt();

        console.log(`✅ Token generated for ${identity}: ${token.substring(0, 20)}...`);

        res.json({ token });
    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).json({ error: 'Failed to generate token', details: error.message });
    }
});

// Shared handler for Element Call SFU JWT requests
async function handleSfuRequest(req, res) {
    try {
        const { room, openid_token, device_id } = req.body;

        if (!room || !openid_token) {
            return res.status(400).json({ error: 'room and openid_token are required' });
        }

        console.log(`📞 Element Call SFU request - Room: ${room}, Device: ${device_id || 'unknown'}`);

        // NOTE: For production you should validate the Matrix OpenID token with the homeserver.
        // For now we trust the token and just use it to derive an identity.
        const identity = device_id || `user_${Date.now()}`;

        // Create LiveKit access token
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity,
            name: identity,
        });

        // Grant full room permissions
        at.addGrant({
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
        });

        const jwt = await at.toJwt();

        // LiveKit server URL (WebSocket URL for connecting)
        const livekitUrl = process.env.LIVEKIT_URL || 'wss://livekit.oriso.site';

        console.log(`✅ SFU token generated for room ${room}, identity: ${identity}`);

        // Element Call expects: { url, jwt }
        res.json({ url: livekitUrl, jwt });
    } catch (error) {
        console.error('❌ Error generating SFU token:', error);
        res.status(500).json({ error: 'Failed to generate SFU token', details: error.message });
    }
}

// Legacy SFU endpoint used by Element Call via /api/livekit/token base URL
app.post('/api/livekit/token/sfu/get', handleSfuRequest);

// MSC4195-compliant MatrixRTC Authorization Service endpoint used via /livekit/jwt base URL
app.post('/livekit/jwt/sfu/get', handleSfuRequest);

app.listen(PORT, () => {
    console.log(`🚀 LiveKit Token Service running on port ${PORT}`);
    console.log(`   API Key: ${LIVEKIT_API_KEY}`);
    console.log(`   Endpoint: http://localhost:${PORT}/api/livekit/token`);
});

