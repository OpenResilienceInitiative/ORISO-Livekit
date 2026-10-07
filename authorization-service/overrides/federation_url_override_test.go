package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/matrix-org/gomatrixserverlib/fclient"
)

func TestFederationURLOverridePreservesLegacyServerName(t *testing.T) {
	const serverName = "203.0.113.10"
	const accessToken = "test-openid-token"
	const expectedUserID = "@user:203.0.113.10"

	authority := httptest.NewTLSServer(
		http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/_matrix/federation/v1/openid/userinfo" {
				t.Fatalf("unexpected path %q", request.URL.Path)
			}
			if request.URL.Query().Get("access_token") != accessToken {
				t.Fatal("OpenID token was not forwarded")
			}
			writer.Header().Set("content-type", "application/json")
			_, _ = writer.Write([]byte(`{"sub":"@user:203.0.113.10"}`))
		}),
	)
	defer authority.Close()

	authorityURL, err := url.Parse(authority.URL)
	if err != nil {
		t.Fatal(err)
	}
	fallbackCalled := false
	exchange := newExchangeOpenIDUserInfoWithFederationOverrides(
		map[string]*url.URL{serverName: authorityURL},
		func(
			context.Context,
			OpenIDTokenType,
			bool,
		) (*fclient.UserInfo, error) {
			fallbackCalled = true
			return nil, nil
		},
	)

	userInfo, err := exchange(
		context.Background(),
		OpenIDTokenType{
			AccessToken:      accessToken,
			MatrixServerName: serverName,
		},
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if fallbackCalled {
		t.Fatal("fallback must not run for a configured authority")
	}
	if userInfo.Sub != expectedUserID {
		t.Fatalf("expected %q, got %q", expectedUserID, userInfo.Sub)
	}
}

func TestFederationURLOverrideRejectsPlainHTTP(t *testing.T) {
	if _, err := parseFederationURLOverrides(
		"203.0.113.10=http://matrix-synapse:8009",
	); err == nil {
		t.Fatal("plain HTTP override must be rejected")
	}
}
