# FunPrinting Partner (desktop)

Electron app that prints a shop's paid FunPrinting orders on a local printer.

```
npm install
npm start                       # production servers
FP_WEB_URL=http://localhost:3000 FP_WSS_URL=http://localhost:8080 npm start   # local servers
npm run build                   # Windows + macOS installers (electron-builder)
```

## How it works

1. **Sign-in.** "Sign in" opens the browser at `/partner/desktop-auth` with a PKCE challenge. The page sends a one-time code back to `http://127.0.0.1:4321/callback`, and the app exchanges it for a 15-minute access token and a 30-day refresh token. Tokens are encrypted with the OS keychain (`safeStorage`) in the app's data folder and never reach the window. Shops can sign the computer out here or on the web dashboard (Signed-in apps).
2. **Jobs.** The app lists the shop's jobs (`/api/partner/v1/jobs`) on start-up, on every socket reconnect, when the socket says `jobs:available`, and every minute. When a printer is selected and printing isn't paused, it claims one job, prints its files one at a time, reports `printing` every 2 minutes, then `printed` (pickup orders are also marked ready for pickup) or `failed`. A job cancelled or refunded on the server is removed from the local queue.
3. **Manual acceptance.** Shops set "New orders: Print automatically / I accept each order first" in Manage Shop Profile. Orders to accept appear at the top with Accept and Decline (declining refunds the customer). The app shows a system notification for each new one.
4. **Errors** go to the web app's error log (`/api/errors`, shown in `/admin/errors`), tied to the shop.

Server side: FunPrinting-Web `docs/PRINT_JOBS.md` and `docs/PARTNER_AUTH.md`.

## Edge cases handled

| Situation | Behaviour |
|---|---|
| App closed or offline | Jobs wait on the server; nothing is pushed and lost. Finished-job reports are saved and sent when back online. |
| Restart mid-job | The job resumes only after the server confirms it is still this computer's; files already printed are skipped. |
| Entries left by the earlier app version | Not printed (they may be old). The orders are still under Manage Orders, with "Print again". |
| Printer fails | 5 attempts with backoff, then the job is reported failed and goes back to the shop's queue; the app waits 2 minutes before taking another. |
| No printer selected, or paused | No new jobs are taken; they stay in the shop's queue for other computers. |
| Two computers in one shop | Each takes one job at a time; a claim is atomic on the server. |
| Signed out (here or from the dashboard) | The current job is handed back (here) or its lease runs out (dashboard), and the app stops. |
| Update downloaded | Installed only when nothing is printing. |
| Second app window | Only one instance runs. |

## Layout

| Path | Purpose |
|---|---|
| `main.js` | Entry point; wires the modules below |
| `src/main/config.js` | Server addresses |
| `src/main/session.js`, `tokenStore.js` | Sign-in, refresh, API calls, token storage |
| `src/main/connection.js` | Socket to the relay (change notifications only) |
| `src/main/jobSync.js` | Job API → local print queue, reports, heartbeats |
| `src/main/ipcHandlers.js`, `preload.js` | IPC; the window calls the partner API through the main process |
| `src/main/errorReporter.js` | Error reports |
| `src/queue/` | Local print queue (saved to `print-queue.json`) |
| `src/printer/` | Printing (Chrome, SumatraPDF, Windows spooler, `lp` on macOS/Linux; mixed colour) |
| `src/ui/` | Window scripts |
