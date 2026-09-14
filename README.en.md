[繁體中文](README.md) ｜ [简体中文](README.zh-CN.md) ｜ [English](README.en.md)

# Appointment & Order Manager

Date preferences, verification-code ingestion, status tracking and an admin dashboard. Orders enter processing directly; there is no payment flow. Automation is implemented for Shanghai, with manual handling for other regions. Queue entry is not a confirmed appointment.

## Run locally

Install Node.js 20 or later, then run:

```sh
npm ci
npm test
```

Copy `.env.example` to `.env`. Generate a random token with the command below and set `ADMIN_TOKEN`. Never upload `.env`.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run `npm start` and open http://localhost:8777; the admin page is `/admin.html`. New data starts with automation paused, listening on loopback only. Review your use case and the official service rules before resuming automation in the admin panel; resuming sends requests to the official service.

Storage is a single-instance JSON file. Phone Link requires an interactive Windows session. Successful booking and long-term reliability still require real-device validation. Publishing the source does not deploy a service.

- [Detailed usage](docs/usage.md)
- [Security and privacy](SECURITY.md)
- [Phone Link](tools/SETUP.md)
