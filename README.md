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

## Pages

| Page | Purpose |
|---|---|
| **Jobs** | Printing on this computer (with progress), orders to accept (Accept / Decline with an optional reason), waiting jobs, jobs on other devices. Pause / resume and refresh. The sidebar shows how many orders need your OK. |
| **Orders** | Every order with Open / Done / All, search by order, file or customer, "Move to…" status changes. Click an order to open its window (summary, customer, preview, status buttons, download, Print again here). Works offline from the last saved list. |
| **Shop** | Earnings, taking orders, acceptance mode, business details, prices, phone numbers, map location (search, my location, drag the pin), delivery points. |
| **Settings** | Account and sign-out, printer, options below, updates, developer mode (adds a Logs page), clear app data. |

Keyboard: Ctrl/⌘ + 1–4 switch pages.

## Options

Defaults keep the earlier behaviour; the rest are opt-in. Saved in `prefs.json` in the app's data folder.

| Option | Default |
|---|---|
| Print an order summary sheet on multi-page orders | On |
| Mark pickup orders ready after printing | On |
| Notify me about orders to accept | On |
| Play a sound for orders to accept | Off |
| Appearance: System / Light / Dark | System |
| Open at login (macOS, Windows) | Off |
| Keep printing when the window is closed (tray / menu bar icon with Pause and Quit) | Off |
| Developer mode (Logs page) | Off |

## Design

Same design tokens as the mobile app: neutral surfaces, brand indigo on content only, light and dark mode. The sidebar uses the platform material (translucent sidebar on macOS, Mica on Windows 11 22H2+). System fonts (SF Pro, Segoe UI Variable), visible keyboard focus, labelled controls, 34 px+ click targets, reduced motion respected. No CDN: Leaflet is bundled and a Content Security Policy limits what the windows can load.

## Edge cases handled

| Situation | Behaviour |
|---|---|
| App closed or offline | Jobs wait on the server; nothing is pushed and lost. Finished-job reports are saved and sent when back online. |
| Restart mid-job | The job resumes only after the server confirms it is still this computer's; files already printed are skipped. |
| Entries left by the earlier app version | Not printed (they may be old). The orders are still under Manage Orders, with "Print again". |
| Wi-Fi printer not set up yet | Settings → **Found on your network** lists it with colour, double-sided and paper sizes. **Add** sets it up in the OS: macOS and Linux with `lpadmin -m everywhere` (driverless, by the printer's `.local` name so a new IP address keeps working); Windows with `Add-Printer -IppURL` (the built-in IPP Class Driver) after one permission prompt. IPP printers switch on straight away. Printers without IPP (raw 9100 / LPD) need their manufacturer's driver on this computer and stay off until a test page prints. |
| Wi-Fi printer switched off, or got a new IP address | It shows offline within 15 seconds (the app opens its port itself; the OS keeps saying "Ready"). On macOS and Linux an offline queue whose printer shows up at another address offers **Update address**. |
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
| `src/main/prefs.js`, `tray.js` | Options; optional tray icon |
| `src/main/session.js`, `tokenStore.js` | Sign-in, refresh, API calls, token storage |
| `src/main/connection.js` | Socket to the relay (change notifications only) |
| `src/main/jobSync.js` | Job API → print runner, reports, heartbeats |
| `src/main/ipcHandlers.js`, `preload.js` | IPC; the window calls the partner API through the main process |
| `src/main/errorReporter.js` | Error reports |
| `src/print/` | Print engine: router, runner, tracker, printer registry. Windows uses the `native/fp-print` add-on (PDFium to GDI); macOS and Linux use CUPS. Mixed colour is split into same-colour PDFs |
| `src/print/discovery/` | Finds Wi-Fi printers on the network (mDNS: IPP, IPPS, raw 9100, LPD), merges them to one entry per printer, reads their properties over IPP, matches them to printers already set up, and notices a printer that stopped answering or moved to a new address |
| `src/print/engines/cupsSetup.js`, `windowsSetup.js` | Setting a found printer up in the OS (the **Add** button) |
| `native/fp-print/` | Rust add-on for Windows printing |
| `src/ui/` | Window scripts: `app.js` (shell), `jobs.js`, `orders.js`, `shop.js`, `settings.js`, `orderWindow.js`, `util.js`, `styles.css` |
