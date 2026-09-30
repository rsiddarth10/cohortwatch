# Security scan reports (S10, 2026-10-01)

| Scan | Tool (pinned) | Target | Result | Files |
|---|---|---|---|---|
| **SAST** | Semgrep 1.95.0, rule sets `p/typescript p/nodejs p/dockerfile p/secrets`, severity ERROR (as in CI) | 370 git-tracked files | **0 findings** (65 rules). One earlier finding, a Dockerfile without USER in `ml/at_risk`, was fixed in S9 | [semgrep.txt](semgrep.txt), [semgrep.json](semgrep.json) |
| **Dependencies, secrets, misconfiguration** | Trivy 0.57.1 `fs --scanners vuln,secret,misconfig --severity CRITICAL,HIGH` | the repository (npm + pip lockfiles, Dockerfiles, Helm, Terraform; `node_modules` and data skipped) | **0 HIGH / 0 CRITICAL** (the table is empty). The first S10 run found 5, all fixed: EKS public endpoint → private only; node egress narrowed (HTTPS via NAT kept, with a documented `trivy:ignore`); web image → `nginx-unprivileged` with `USER 101`; Helm web container → read-only root filesystem | [trivy-fs.txt](trivy-fs.txt) |
| **DAST: web** | OWASP ZAP 2.15.0 `zap-baseline.py` | the web app (nginx + React), clean-clone stack | **0 High, 0 Low**; 2 Medium (see below). First run: 0 High, 3 Medium, 3 Low; the missing headers were fixed | [zap-baseline-web.html](zap-baseline-web.html), [.md](zap-baseline-web.md) |
| **DAST: API** | OWASP ZAP 2.15.0 `zap-api-scan.py` from `/api/openapi.json`, **authenticated** (real lead token from the OIDC flow) | every documented endpoint, through the web proxy | **0 High**; all SQL injection (incl. PostgreSQL), XSS, CRLF and path-traversal rules pass. 1 Medium (see below), 2 Low | [zap-api.html](zap-api.html), [.md](zap-api.md) |
| SBOM | CycloneDX (`@cyclonedx/cyclonedx-npm` 1.19.3), spec 1.5 | npm workspaces | 593 components | [/sbom.cdx.json](../../../sbom.cdx.json) |

## Remaining findings, explained

- **ZAP "is out of date" (Medium, both scans):** about the scanner image (2.15.0 was pinned for reproducibility),
  not the application.
- **CSP `style-src 'unsafe-inline'` (Medium, web):** React and Recharts set inline `style` attributes (chart geometry,
  colours), which needs this. Scripts stay strict (`script-src 'self'`, no inline script, no `eval`), so the XSS
  exposure the CSP guards against is closed. Removing it would mean a nonce-based style setup and a different
  chart library. Accepted.
- **API Low findings:** "Server leaks version via the Server header" comes from the API's own responses through the
  proxy. "Unexpected Content-Type" is on error responses to ZAP's malformed probes (the API answers 400/404 JSON).
  Neither exposes data.
- **API scan: an invalid first attempt.** It targeted `api:3100/api/...`, but the spec's server is `/api`, the web
  proxy prefix, so every request got a 404. ZAP then flagged "SQL Injection" on those 404 pages, a false positive
  on an unreachable path. The valid run goes through the web proxy, and all injection rules pass.

## First web scan → fixes (commits `49645bc`, `219e3d5`)

| Finding (first run) | Fix |
|---|---|
| CSP header not set (Medium) | `Content-Security-Policy` in `apps/web/nginx.conf` (`default-src 'self'`, strict `script-src`, `frame-ancestors 'none'`, `object-src 'none'`, no wildcards) |
| Missing anti-clickjacking header (Medium) | `X-Frame-Options: DENY` + `frame-ancestors 'none'` |
| X-Content-Type-Options missing (Low) | `nosniff` |
| Permissions Policy not set (Low) | `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| Server version leak (Low) | `server_tokens off` |

The browser e2e viewer test (login, REST, SSE page render) passes with the new CSP.
