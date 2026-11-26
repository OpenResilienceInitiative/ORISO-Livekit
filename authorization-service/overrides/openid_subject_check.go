package main

import (
	"context"
	"errors"
	"strings"

	"github.com/matrix-org/gomatrixserverlib/fclient"
)

// Backport of the GHSA-rq24-fh66-rq7x fix (upstream lk-jwt-service v0.8.0).
// A homeserver may only vouch for its own users: the `sub` returned by
// /openid/userinfo must be a Matrix user ID whose server name equals the
// server the OpenID token was exchanged with. Otherwise a malicious
// homeserver could obtain LiveKit tokens for users of another server.
var errOpenIDSubjectServerMismatch = errors.New(
	"OpenID subject does not belong to the issuing homeserver",
)

// openIDSubjectBelongsTo reports whether sub is "@localpart:serverName".
// The server name follows the first colon and may itself carry a port.
func openIDSubjectBelongsTo(sub string, serverName string) bool {
	localpart, subServerName, ok := strings.Cut(
		strings.TrimPrefix(sub, "@"),
		":",
	)
	return ok &&
		strings.HasPrefix(sub, "@") &&
		localpart != "" &&
		serverName != "" &&
		subServerName == serverName
}

func newExchangeOpenIDUserInfoWithSubjectServerCheck(
	exchange func(
		context.Context,
		OpenIDTokenType,
		bool,
	) (*fclient.UserInfo, error),
) func(context.Context, OpenIDTokenType, bool) (*fclient.UserInfo, error) {
	return func(
		ctx context.Context,
		token OpenIDTokenType,
		skipVerifyTLS bool,
	) (*fclient.UserInfo, error) {
		userInfo, err := exchange(ctx, token, skipVerifyTLS)
		if err != nil {
			return nil, err
		}
		if userInfo == nil ||
			!openIDSubjectBelongsTo(userInfo.Sub, token.MatrixServerName) {
			return nil, errOpenIDSubjectServerMismatch
		}
		return userInfo, nil
	}
}

// installOpenIDSubjectServerCheck wraps the active OpenID exchange, including
// any federation URL override, so it must run after those are installed.
func installOpenIDSubjectServerCheck() {
	exchangeOpenIdUserInfo =
		newExchangeOpenIDUserInfoWithSubjectServerCheck(exchangeOpenIdUserInfo)
}
