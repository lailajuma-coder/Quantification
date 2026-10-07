# Self-host KidneyQuant on your own domain

KidneyQuant is designed to run from infrastructure and a domain you control. The private ChatGPT Site is only a review copy; it is not a required production host.

> **Research use only.** This Phase-1 build is experimental and is not a medical device, diagnostic system, or validated clinical tool.

## Request path and trust boundaries

The preferred production path is:

```text
browser -> HTTPS Nginx Proxy Manager -> auth:8080 -> web:3000 -> analysis:8000
```

- Nginx Proxy Manager (NPM) terminates public HTTPS and forwards only to `kidneyquant-auth:8080`.
- `auth` provides Basic Auth, delayed failed-auth responses, per-client request limits, at most two concurrent decode connections per client, a 512 MiB body limit, and response security headers. The analysis companion independently serializes decode work with `MAX_CONCURRENT_DECODES=1`.
- `auth` overwrites the user and proxy-assertion headers. `web` independently compares the assertion with a shared external secret before it trusts the Basic Auth username. `/api/decode` performs the same assertion and username checks.
- The assertion is a protected host file mounted read-only into `auth` and `web`; its value is never stored in Compose, an environment variable, an image layer, or source control. The auth entrypoint validates it and renders the nginx configuration into the container's private `/tmp` tmpfs.
- Client identity for rate limits comes from `X-Forwarded-For` only when the socket peer belongs to the operator-configured trusted ingress CIDR. Never use `0.0.0.0/0`, `::/0`, or a client-controlled header source.
- No service publishes a host port. The optional Cloudflare tunnel can reach only `auth` on `auth-edge`; it cannot reach `web` or `analysis` directly.

The Compose networks intentionally form narrow hops:

| Network | Members | Purpose |
|---|---|---|
| `nginx-proxy-manager_default` | NPM and `auth` | preferred HTTPS ingress |
| `auth-edge` | `auth` and optional `tunnel` | tunnel ingress only |
| `auth-web` | `auth` and `web` | authenticated application traffic |
| `web-analysis` | `web` and `analysis` | private decode traffic |
| `tunnel-egress` | optional `tunnel` | tunnel provider egress |

`analysis` shares no network with either ingress. `tunnel` shares only `auth-edge` with `auth` and therefore cannot bypass authentication.

## What runs where

- **TIFF:** an unsigned, uncompressed, single-plane BlackIsZero grayscale or interleaved RGB TIFF is decoded locally in the browser. The source TIFF is not uploaded to the site; unsupported compressed or ambiguous variants fail closed.
- **JP2-family and ND2:** the browser sends the raw file as `application/octet-stream` with an allowlisted `X-KidneyQuant-File-Extension`. `web` streams that body to the private `analysis` companion without creating a multipart copy. The companion uses a request-scoped temporary file, returns losslessly compressed native unsigned samples when requested by the updated client (PNG for legacy clients), and deletes the upload after the request.
- **Exports:** CSV and JSON files are downloaded by the user. Phase 1 intentionally has no project database or image archive.

Browser-local TIFF input is capped at **128 MiB** by the application. Companion-bound ND2 and JP2-family uploads remain capped at **512 MiB** at auth and in the service environment; configure every proxy or CDN in front of auth to the same 512 MiB limit because a lower upstream limit wins. The companion also rejects a selected plane above **8 million pixels** (`MAX_DECODED_PIXELS=8000000`) or more than **3 retained channels/components** before pixel decoding/compute where format metadata permits.

## Prerequisites and protected files

1. Docker Engine and the Docker Compose plugin.
2. An existing external Docker network named `nginx-proxy-manager_default`, shared with NPM.
3. A protected htpasswd file provisioned outside the repository.
4. A separate random proxy-assertion file provisioned outside the repository. Generate at least 256 bits as one base64url-safe line; 64 hexadecimal characters is valid.
5. A DNS name and NPM certificate for the HTTPS origin in `NEXT_PUBLIC_SITE_ORIGIN`.
6. The exact IPv4 or IPv6 CIDR from which the ingress proxy connects to `auth`. Prefer a stable proxy `/32` or `/128`, or the smallest dedicated proxy subnet. Do not guess this value.
7. If the optional tunnel is enabled, a separate protected token file outside the repository; never place its contents in Compose argv or environment variables.

The `auth` and `web` containers both run as UID/GID `10001`. Make the htpasswd and assertion files readable by that identity and by no broader identity. Compose sets `bind.create_host_path: false`, so a typo or missing source fails instead of silently creating a directory. One operator workflow is:

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /protected/kidneyquant
sudo sh -c 'umask 077; openssl rand -hex 32 > /protected/kidneyquant/proxy-assertion'
sudo chown 10001:10001 /protected/kidneyquant/proxy-assertion /protected/kidneyquant/htpasswd
sudo chmod 0400 /protected/kidneyquant/proxy-assertion /protected/kidneyquant/htpasswd
```

Create the htpasswd file with the operating system's supported `htpasswd` tool before applying the final ownership and mode. The paths above are examples only. Do not print either file during validation. Rotate the assertion by writing a new protected file atomically and then recreating `auth` and `web` together; a one-sided rotation intentionally fails closed.

Use a mode-0600 `.env` file or another protected Compose environment source. Store paths, never the assertion value:

```dotenv
NEXT_PUBLIC_SITE_ORIGIN=https://kidneyquant.example.org
KIDNEYQUANT_HTPASSWD_PATH=/protected/kidneyquant/htpasswd
KIDNEYQUANT_PROXY_ASSERTION_PATH=/protected/kidneyquant/proxy-assertion
KIDNEYQUANT_TRUSTED_PROXY_CIDR=172.30.0.10/32
```

The CIDR above is a placeholder. Determine the real source from the deployed ingress network and keep it stable across proxy recreation. If an optional tunnel uses a different direct source CIDR, do not enable it until auth is configured and tested to trust that smallest source range; otherwise tunnel requests intentionally share the tunnel peer's rate-limit bucket. Do not broaden trust to the public internet to make a tunnel work.

## Preflight (no deployment)

Run these checks before an approved rollout. They parse configuration and build images but do not start or replace the stack:

```bash
# Verify presence, owner, and mode without reading contents.
stat -c '%n %u:%g %a %F' "$KIDNEYQUANT_HTPASSWD_PATH" "$KIDNEYQUANT_PROXY_ASSERTION_PATH"

# Render Compose with all required variables and inspect only non-secret topology.
docker compose config --quiet
docker compose config --services
docker compose config --images

# Build every first-party image from the allowlisted contexts.
docker compose build web analysis auth

# Project tests and production build.
npm test
npm run lint
npm run build
python -m unittest discover -s analysis-service -p 'test_*.py' -v
```

`auth` will fail closed at startup if the assertion is absent, unreadable, multiline, too short, contains characters outside base64url, or if the trusted proxy CIDR is missing/malformed. Its health check is not a static nginx response: it sends a bodyless request through `auth -> web -> /api/ready` with the shared assertion. The dedicated readiness route returns `204` only when the mounted web assertion matches; the ordinary protected access page is not considered healthy. Therefore one-sided assertion rotation or a broken protected web hop keeps `auth` unhealthy.

Before rollout, also verify that the NPM host forwards to `kidneyquant-auth:8080`, its source address is inside the configured CIDR, its upload limit is at least 512 MiB, and it overwrites or correctly appends the real client address. Rate-limit validation must use two distinct external client addresses; seeing separate `$remote_addr` values in auth access logs confirms that clients are not collapsing into the proxy's address. Do not log the assertion header.

## Local build and approved start

For a local, non-release build:

```bash
docker compose build
docker compose up -d --no-build --wait
docker compose ps
```

Compose does not publish ports 3000, 8000, or 8080. A direct `web` request cannot become an authenticated session by spoofing `Host`, `X-KidneyQuant-Authenticated-User`, or the assertion header; the value must match the mounted external file.

After an approved rollout, verify:

1. `docker compose ps` reports `analysis`, `web`, and `auth` healthy.
2. Plain HTTP redirects to the canonical HTTPS origin; HTTPS validates without bypassing certificate checks, returns `401` without Basic Auth, and includes `Strict-Transport-Security`.
3. A valid login reaches the workbench and a small allowlisted decode succeeds.
4. A request with a fake assertion sent directly from an isolated test container on `auth-web` receives the protected access page, and `/api/decode` returns `403`.
5. Network inspection matches the membership table above; especially, `analysis` is only on `web-analysis` and `tunnel` is not on `auth-web` or `web-analysis`.

## Nginx Proxy Manager

Create or update one NPM proxy host:

| Setting | Value |
|---|---|
| Scheme | `http` |
| Forward hostname | `kidneyquant-auth` |
| Forward port | `8080` |
| Public SSL | enabled and forced |
| HSTS | enabled after HTTPS is verified; include subdomains only if every subdomain is HTTPS-ready |
| WebSocket support | enabled |

Do not attach `web` or `analysis` to the NPM network, forward directly to either service, or add host port mappings as a workaround. Set any NPM advanced body-size directive to `client_max_body_size 512m;`. The bundled auth configuration applies the same limit and disables request buffering so microscopy uploads stream to the application.

After rollout, verify the public route rather than only container health: plain HTTP must redirect to the canonical HTTPS origin; HTTPS must validate with the system trust store (do not use `curl -k`); unauthenticated HTTPS must return `401`; and the HTTPS response must contain `Strict-Transport-Security`. A safe header-only check is `curl --silent --show-error --head https://kidneyquant.example.org/`; inspect the real origin and certificate before enabling a long HSTS lifetime.

The auth response also sets `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a restrictive `Permissions-Policy` disabling camera, microphone, geolocation, and browsing topics. Basic Auth terminates at nginx; it clears `Authorization` before proxying so the web process never receives the reusable password.

The app never accepts NPM's network location alone as authentication. Basic Auth establishes the username, while the shared assertion proves that the username header was set by this auth image. nginx always discards any inbound `X-KidneyQuant-Authenticated-User`, Cloudflare authenticated-user header, and `X-KidneyQuant-Proxy-Assertion` before setting its own values.

## Immutable releases

Do not deploy moving tags such as `latest` and do not rebuild a tag in place. Give each release a unique ID, build the three first-party images once, push them to an access-controlled registry, and record the registry manifest digest for each image:

```bash
RELEASE=2026-08-31.1
REGISTRY=registry.example.org/kidneyquant

docker buildx build --platform linux/amd64,linux/arm64 --push -t "$REGISTRY/web:$RELEASE" .
docker buildx build --platform linux/amd64,linux/arm64 --push -f analysis-service/Dockerfile -t "$REGISTRY/analysis:$RELEASE" .
docker buildx build --platform linux/amd64,linux/arm64 --push -f auth/Dockerfile -t "$REGISTRY/auth:$RELEASE" auth

docker buildx imagetools inspect "$REGISTRY/web:$RELEASE"
docker buildx imagetools inspect "$REGISTRY/analysis:$RELEASE"
docker buildx imagetools inspect "$REGISTRY/auth:$RELEASE"
```

Record the resulting `repo@sha256:...` references in the protected deployment environment:

```dotenv
KIDNEYQUANT_WEB_IMAGE=registry.example.org/kidneyquant/web@sha256:replace-with-recorded-digest
KIDNEYQUANT_ANALYSIS_IMAGE=registry.example.org/kidneyquant/analysis@sha256:replace-with-recorded-digest
KIDNEYQUANT_AUTH_IMAGE=registry.example.org/kidneyquant/auth@sha256:replace-with-recorded-digest
```

Pre-pull and verify those exact references, archive the release ID plus all three digests, then use `docker compose up -d --no-build --wait`. `--no-build` is mandatory for a digest rollout: deployment must consume the reviewed artifacts, not rebuild from whatever source happens to be on the host. The Node, Python, nginx, and cloudflared bases in this repository are also digest-pinned; update them only through a reviewed release.

## Rollback

Keep the previous release's three digest references and rendered non-secret Compose configuration until the new release passes verification. To roll back:

1. Restore the archived previous Compose file/project configuration and its three previous `repo@sha256:...` image values together. Do not run rollback from the failed release's Compose definition and do not mix web/API protocol versions from different releases.
2. Render `docker compose config` and compare its non-secret topology with the archived previous rendering before starting it.
3. `docker compose pull web analysis auth`.
4. `docker compose up -d --no-build --wait`.
5. Re-run the post-rollout checks, including unauthenticated `401`, auth readiness, one small decode, and network membership.
6. Preserve logs and the failed release's digest manifest for incident review; do not retag the failed images as the old release.

The stack has no application database, so rollback is image/config rollback. Uploaded images remain request-scoped temporary data and are not migration state.

## Optional Cloudflare Tunnel profile

The tunnel image is tag-and-digest pinned. Put the tunnel token in a protected external file readable by the cloudflared UID/GID `65532`, set `CF_TUNNEL_TOKEN_PATH` to that file, configure the tunnel origin as `http://auth:8080`, and start it only after reviewing the alternate source CIDR and real-IP behavior. Compose mounts the file with `bind.create_host_path: false`, and cloudflared reads it with `--token-file`; the token value is not placed in Compose argv or environment variables:

```dotenv
CF_TUNNEL_TOKEN_PATH=/protected/kidneyquant/cloudflared-token
```

```bash
docker compose --profile domain up -d tunnel --no-build
```

Never point a tunnel at `web`. The tunnel container is deliberately absent from `auth-web` and `web-analysis`. The preferred production route remains NPM -> auth -> web.

## Experimental processing and scientific scope

Phase 1 provides threshold-based positive-area quantification, connected slide-background exclusion, analyst-reviewed rectangular regions, and provenance-rich CSV/JSON metrics. Structure labels are not generated by a validated automatic histology model.

The companion selects the first available ND2 image plane. The updated client preserves unsigned 8/16-bit samples for measurement and scales only the preview. Deploy web and companion together: a legacy PNG-only companion is rejected for high-bit-depth measurements. Native transport is little-endian interleaved Y,X[,C], gzip level 1, negotiated with Accept: application/vnd.kidneyquant.samples+gzip. Measurements remain experimental. Multi-plane selection and calibrated physical units are not implemented.

Before publication—or any use beyond exploratory research—validate thresholds, channel assignment, background tolerance, ROI method, first-plane selection, preview scaling, and agreement with the lab's Fiji reference workflow on a blinded test set. Add pixel calibration if physical units such as µm² or µm are required. Do not use KidneyQuant for diagnosis, treatment decisions, or other clinical purposes.
