# Security Policy

## Supported Versions

Only the latest release on the default branch receives security fixes.

## Deployment Boundary

VidHarbor has no authentication, authorization, user isolation, or public-network security boundary. It is intended for a single user on localhost or a trusted private network. Do not expose the application port directly to the public internet.

The SQLite database may contain plaintext proxy credentials. The read-only database page can display those values to anyone who can reach the application.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting from the repository's **Security** tab. Include the affected version, reproduction steps, impact, and any proposed mitigation.

Do not open a public issue containing an undisclosed vulnerability, credentials, private media URLs, database contents, or exploit details. Security reports are handled on a best-effort basis; no response-time guarantee is provided.
