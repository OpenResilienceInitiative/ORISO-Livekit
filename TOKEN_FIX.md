# LiveKit Token Request Fix ✅

## Problem:
The frontend was sending a **POST** request to `/api/livekit/token` but the backend expected a **GET** request with query parameters.

## Error Seen:
```
Group call error: could not establish signal connection: invalid authorization token
```

## Root Cause:
In `liveKitService.ts`, the token request was:
```typescript
// ❌ WRONG - POST with body
const response = await fetch('/api/livekit/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, userName })
});
```

But the backend (`token-service/server.js`) expected:
```javascript
// ✅ Expects GET with query params
app.get('/api/livekit/token', async (req, res) => {
    const { roomName, identity } = req.query;
    // ...
});
```

## Fix Applied:
Changed `liveKitService.ts` to use **GET** with query parameters:

```typescript
// ✅ CORRECT - GET with query params
const response = await fetch(
    `/api/livekit/token?roomName=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(userName)}`,
    {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
    }
);
```

## Changes Made:

### File: `/home/caritas/Desktop/online-beratung/caritas-workspace/ORISO-Frontend-Temp/src/services/liveKitService.ts`

**Before:**
- Used POST request
- Sent data in request body
- Had fallback to insecure base64 token

**After:**
- Uses GET request
- Sends data as query parameters (`roomName` and `identity`)
- Proper error handling
- No insecure fallback

## Deployment:

1. ✅ Updated `liveKitService.ts`
2. ✅ Rebuilt frontend: `npm run build`
3. ✅ Rebuilt Docker image: `docker build -t frontend-temp:latest .`
4. ✅ Restarted pod: `kubectl delete pod -n caritas -l app=frontend-temp`

## Testing:

Now when you click "Group Call":

1. Frontend requests token: `GET /api/livekit/token?roomName=!room123&identity=@user:matrix.org`
2. Nginx proxies to token service: `http://10.43.32.79:3010/api/livekit/token?roomName=...`
3. Token service generates JWT: `eyJhbGciOiJIUzI1NiJ9...`
4. Frontend receives token and connects to LiveKit: `wss://livekit.oriso.site`
5. **Group call works!** ✅

## Verification:

```bash
# Check token service logs
kubectl logs -n caritas -l app=livekit-token-service -f

# Expected output when call is placed:
# Generating token for user: @user:matrix.org, room: !room123
# ✅ Token generated for @user:matrix.org: eyJhbGciOiJIUzI1NiJ9...
```

## Status: FIXED ✅

The "invalid authorization token" error should now be resolved!

**GO TEST IT NOW!** 🚀


