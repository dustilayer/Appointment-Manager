# Security and privacy

This repository contains source code, not a running hosted service. Publishing it does not upload local configuration or order data.

## Safe local defaults

- Set a randomly generated `ADMIN_TOKEN` of at least 32 characters. There is no built-in token. Generate it with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Use a different token for `SMS_INGEST_TOKEN`, or leave it empty to disable ingestion.
- The server listens on `127.0.0.1` by default. New databases start with automation paused. Do not resume until you intend to send requests to the official booking service.
- `.env`, local data, database backups, private keys, logs and Git bundles are excluded from Git and/or the container build context. Always inspect staged files before pushing.
- Remote code forwarding requires HTTPS; HTTP is accepted only for loopback addresses. Diagnostic output hides notification contents and verification codes.

## Before deploying a public service

The application is not a production security certification. It currently uses a single-instance JSON database. The operator is responsible for restricted filesystem access, disk encryption, retention, backups, HTTPS, abuse controls and monitoring.

An order link is a bearer link: anyone holding it can read its status. Keep links private. Recovery currently uses a matching name and phone number with rate limits; these are not strong authentication factors. Before accepting real users on the public Internet, add verified identity or one-time-code recovery and a suitable access-control model. Do not rely on this demo's rate limiting as your only abuse protection.

Cancellation stops subsequent local processing but cannot retract a request already sent to an external service. Verify the official result. Phone Link automation depends on an interactive Windows session and must not be used as a reason to disable workstation protections.

## Reporting a problem

Use GitHub's private vulnerability reporting feature if available. Do not publish real tokens, personal information, order links, notification screenshots or configuration in public issues. If a secret was exposed, revoke or rotate it; deleting a file or rewriting a commit is not a substitute.

## Verification scope

`npm test` checks the local order lifecycle, legacy-data upgrade, removed payment endpoints, request validation, access controls, safe defaults and frontend escaping without contacting the booking site or SMS provider. It does not prove successful appointments, hardware compatibility or absence of all vulnerabilities.
