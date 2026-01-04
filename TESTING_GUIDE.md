# LiveKit Group Calls - Testing Guide

## Latest Fix (11:04)

### What Was Fixed:
1. **FloatingCallWidget** was starting Matrix calls even for group calls
2. `callInitiatedRef` was not being reset for new calls
3. The "other user initial" useEffect was running for group calls

### Changes Made:
1. Added `callInitiatedRef.current = false` when new call data arrives
2. Added group call skip check in the "other user initial" useEffect
3. Ensured FloatingCallWidget completely ignores group calls

## How to Test:

### Step 1: Hard Refresh Browser
**CRITICAL**: Clear your browser cache first!
- **Chrome/Firefox**: `Ctrl + Shift + R` or `Ctrl + F5`
- **Mac**: `Cmd + Shift + R`

### Step 2: Open Browser Console
Press `F12` to open developer tools and watch the console logs.

### Step 3: Start a Group Call

1. Open a group chat with 2+ people
2. Click the **video call button**
3. **Watch the console logs**

### Expected Logs (CORRECT):

```
🎬 GROUP CALL BUTTON CLICKED (GroupChatHeader)!
🎤 Requesting media permissions (SYNC with user click)...
✅ Media permissions granted!
📞 Starting call via CallManager with roomId: !xxx
🎯 This is a GROUP CHAT - forcing isGroup=true
═══════════════════════════════════════════════
🚀 CallManager.startCall()
   Room ID: !xxx
   Is Video: true
   Force Group: true
   ✅ Is group call (forced): true
✅ Outgoing call created: { isGroup: true, ... }
═══════════════════════════════════════════════
📡 GroupCallWidget: CallManager update: { isGroup: true, ... }
📞 Starting LiveKit group call...
📞 Connecting to LiveKit room: !xxx
🔑 Requesting LiveKit token for: { roomName: "!xxx", userName: "..." }
✅ Received LiveKit token: eyJhbGci...
🔌 Connecting to: wss://livekit.oriso.site
✅ Connected to LiveKit room
✅ Published local tracks
👥 Participants updated: 1 [...]
```

### What You Should NOT See:

❌ **NO Matrix WebRTC logs** like:
- `Call 1764154879469vBObBSUzk6NGSFZu onNegotiationNeeded()`
- `sendEvent of type m.call.invite`
- `FetchHttpApi: --> PUT https://matrix.oriso.site/_matrix/client/v3/rooms/.../send/m.call.invite`
- `Fetching new TURN credentials`
- `MediaHandler getUserMediaStreamInternal()`

❌ **NO FloatingCallWidget logs** like:
- `👤 Other user: consultantlatest3 → Initial: C FloatingCallWidget.tsx`
- `✅ Using pre-requested media stream (mobile-friendly!)`
- `📞 Starting video call in room: !xxx matrixCallService.ts`

### If You See Matrix WebRTC Logs:

The fix didn't work. Check:
1. Did you hard refresh? (`Ctrl + Shift + R`)
2. Is the new JS file loaded? Check Network tab for `app.a4a3b945.js`
3. Are you testing in the correct group chat?

## Success Criteria:

✅ **Group Call Widget** appears (not 1-on-1 widget)
✅ **LiveKit connection** established
✅ **NO Matrix WebRTC** calls initiated
✅ **NO errors** in console
✅ **Video streams** appear for all participants

## Current Deployment Status:

- **Build Time**: 11:04 (Nov 26, 2025)
- **Build File**: `app.a4a3b945.js`
- **Pod Status**: Running ✅
- **LiveKit Server**: Running ✅
- **Token Service**: Running ✅

## If It Still Doesn't Work:

1. Check browser console for errors
2. Copy the FULL console log and send it
3. Check Network tab for failed requests
4. Verify you're in a group chat (3+ members)

## Testing with Multiple Users:

1. Open 3 browser windows (or use 3 devices)
2. Login as 3 different users
3. All join the same group chat
4. User A clicks video call
5. Users B and C should see incoming call
6. All click "Answer"
7. **Result**: All 3 users see each other! ✅

---

**GO TEST IT NOW!** 🚀

Remember: **HARD REFRESH** your browser first! (`Ctrl + Shift + R`)


