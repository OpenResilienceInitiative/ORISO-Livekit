package main

import (
	"context"
	"errors"
	"testing"

	"github.com/matrix-org/gomatrixserverlib/fclient"
)

// GHSA-rq24-fh66-rq7x: a homeserver answering /openid/userinfo must only be
// able to vouch for its own users. Without the check, a malicious homeserver
// could return the Matrix ID of a user on another server and the service
// would mint a LiveKit token for that victim.
func stubOpenIDUserInfo(t *testing.T, sub string) *int {
	t.Helper()
	calls := 0
	original := exchangeOpenIdUserInfo
	t.Cleanup(func() { exchangeOpenIdUserInfo = original })
	exchangeOpenIdUserInfo = func(
		_ context.Context,
		_ OpenIDTokenType,
		_ bool,
	) (*fclient.UserInfo, error) {
		calls++
		return &fclient.UserInfo{Sub: sub}, nil
	}
	installOpenIDSubjectServerCheck()
	return &calls
}

func TestVerifyOpenIDTokenRejectsSubjectFromAnotherServer(t *testing.T) {
	stubOpenIDUserInfo(t, "@victim:oriso.test")
	handler := &Handler{}

	for _, claimedUserID := range []string{"", "@victim:oriso.test"} {
		matrixID, err := handler.verifyOpenIDToken(
			context.Background(),
			OpenIDTokenType{
				AccessToken:      "token",
				MatrixServerName: "evil.test",
			},
			claimedUserID,
		)
		if err == nil {
			t.Fatalf(
				"claimed %q: token for %q accepted from evil.test",
				claimedUserID,
				matrixID,
			)
		}
		var matrixErr *MatrixErrorResponse
		if !errors.As(err, &matrixErr) || matrixErr.ErrCode != "M_UNAUTHORIZED" {
			t.Fatalf("claimed %q: want M_UNAUTHORIZED, got %v", claimedUserID, err)
		}
	}
}

func TestVerifyOpenIDTokenAcceptsSubjectFromIssuingServer(t *testing.T) {
	for _, tc := range []struct{ server, sub string }{
		{"oriso.test", "@alice:oriso.test"},
		{"oriso.test:8448", "@alice:oriso.test:8448"},
	} {
		stubOpenIDUserInfo(t, tc.sub)
		matrixID, err := (&Handler{}).verifyOpenIDToken(
			context.Background(),
			OpenIDTokenType{AccessToken: "token", MatrixServerName: tc.server},
			tc.sub,
		)
		if err != nil || matrixID != tc.sub {
			t.Fatalf("%s: got (%q, %v), want %q", tc.server, matrixID, err, tc.sub)
		}
	}
}

func TestVerifyOpenIDTokenRejectsMalformedSubject(t *testing.T) {
	for _, sub := range []string{
		"",
		"alice:oriso.test",
		"@:oriso.test",
		"@alice",
		"@alice:",
		"@alice:oriso.test.evil.test",
		"@alice:evil.test:oriso.test",
	} {
		stubOpenIDUserInfo(t, sub)
		if _, err := (&Handler{}).verifyOpenIDToken(
			context.Background(),
			OpenIDTokenType{AccessToken: "token", MatrixServerName: "oriso.test"},
			"",
		); err == nil {
			t.Fatalf("subject %q accepted for oriso.test", sub)
		}
	}
}
