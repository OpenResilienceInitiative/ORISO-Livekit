package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/matrix-org/gomatrixserverlib/fclient"
	"github.com/matrix-org/gomatrixserverlib/spec"
)

type federationURLOverrideTransport struct {
	baseURL   *url.URL
	transport http.RoundTripper
}

func (t federationURLOverrideTransport) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	if request.URL.Scheme != "matrix" {
		return nil, errors.New("unexpected non-Matrix OpenID request")
	}

	rewritten := request.Clone(request.Context())
	rewrittenURL := *request.URL
	rewrittenURL.Scheme = t.baseURL.Scheme
	rewrittenURL.Host = t.baseURL.Host
	rewritten.URL = &rewrittenURL
	rewritten.Host = t.baseURL.Host
	return t.transport.RoundTrip(rewritten)
}

func parseFederationURLOverrides(raw string) (map[string]*url.URL, error) {
	overrides := make(map[string]*url.URL)
	if strings.TrimSpace(raw) == "" {
		return overrides, nil
	}

	for _, entry := range strings.Split(raw, ",") {
		serverName, rawURL, ok := strings.Cut(entry, "=")
		if !ok {
			return nil, errors.New("invalid federation URL override")
		}
		serverName = strings.TrimSpace(serverName)
		rawURL = strings.TrimSpace(rawURL)
		parsedURL, err := url.Parse(rawURL)
		if err != nil ||
			serverName == "" ||
			parsedURL.Scheme != "https" ||
			parsedURL.Host == "" ||
			parsedURL.Path != "" ||
			parsedURL.RawQuery != "" ||
			parsedURL.Fragment != "" {
			return nil, errors.New("invalid federation URL override")
		}
		overrides[serverName] = parsedURL
	}
	return overrides, nil
}

func newExchangeOpenIDUserInfoWithFederationOverrides(
	overrides map[string]*url.URL,
	fallback func(
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
		override := overrides[token.MatrixServerName]
		if override == nil {
			return fallback(ctx, token, skipVerifyTLS)
		}
		if token.AccessToken == "" {
			return nil, errors.New("missing OpenID access token")
		}

		transport := http.DefaultTransport.(*http.Transport).Clone()
		if skipVerifyTLS {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		}
		client := fclient.NewClient(
			fclient.WithTransport(
				federationURLOverrideTransport{
					baseURL:   override,
					transport: transport,
				},
			),
		)
		userInfo, err := client.LookupUserInfo(
			ctx,
			spec.ServerName(token.MatrixServerName),
			token.AccessToken,
		)
		if err != nil {
			return nil, fmt.Errorf("federation OpenID lookup failed")
		}
		return &userInfo, nil
	}
}

func installFederationURLOverridesFromEnvironment() error {
	overrides, err := parseFederationURLOverrides(
		os.Getenv("LIVEKIT_FEDERATION_URL_OVERRIDES"),
	)
	if err != nil {
		return err
	}
	if len(overrides) == 0 {
		return nil
	}
	exchangeOpenIdUserInfo =
		newExchangeOpenIDUserInfoWithFederationOverrides(
			overrides,
			exchangeOpenIdUserInfo,
		)
	return nil
}
