# UniTracker backend

The API uses Google OAuth 2.0 to connect a Gmail account with the read-only `gmail.readonly` scope. It never requests permission to send, delete, or modify email.

## Configure Google OAuth

1. Create a Google Cloud project, enable the Gmail API and Routes API, and create an OAuth client for a web application.
2. Add `http://localhost:3001/api/auth/google/callback` as an authorized redirect URI and `http://localhost:3001` as an authorized JavaScript origin.
3. Copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Keep the secret on the backend only. Set `GOOGLE_REDIRECT_URI` to the exact callback URI configured in Google Cloud.
4. Set `GOOGLE_MAPS_API_KEY` to enable traffic aware travel estimates. A missing Routes key still allows Gmail sync and Google Maps direction links. For the embedded interactive route map, enable Maps Embed API and create a separate browser key; add it as `VITE_GOOGLE_MAPS_EMBED_KEY` in `frontend/.env.local`. Restrict that key to Maps Embed API and the app's website referrer (for local development, `http://localhost:3001/*`). It is expected to be visible to the browser; keep the Routes key in `Backend/.env` only.
5. Install frontend packages once with `npm ci` in `frontend`. Then run `npm run dev` from this `Backend` directory to start both servers. Open `http://localhost:3001`; Vite proxies `/api` requests to the backend on `3002`, so the browser uses one port for both.
6. Run MongoDB Community Server locally or provide a MongoDB Atlas URI. Set `MONGODB_URI` and `MONGODB_DATABASE` in `.env`. MongoDB Compass is the GUI client: connect Compass to the same URI, open the `UniTracker` database, then inspect its `events` collection.

## Where credentials go

Copy `Backend/.env.example` to `Backend/.env`. Add real secret values there; do not put them in React source or any `VITE_` variable. Restart `npm run dev` after changing the file because the backend reads it at startup. The Auto-Sync page reports whether OAuth, Maps, and MongoDB are ready; `/api/health` returns only configuration status, never secret values.

| Variable | Value to add |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | A server-side Google Maps Platform key with Routes API enabled. Restrict it to the Routes API. |
| `GOOGLE_CLIENT_ID` | The OAuth 2.0 Web client ID from Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | The matching OAuth client secret. Backend only. |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3001/api/auth/google/callback`; register this exact URI in the OAuth client. |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` for local MongoDB, or your Atlas connection URI. |
| `MONGODB_DATABASE` | `UniTracker` by default. MongoDB database names are case sensitive; use the exact existing database name. |
| `PORT` | `3002`, the backend's internal port behind the Vite proxy. |
| `FRONTEND_ORIGIN` | `http://localhost:3001`, the single browser-facing origin. |

`frontend/.env.example` contains relative `/api` paths and a placeholder for the browser-restricted Maps Embed key. Copy it to `frontend/.env.local`, replace the placeholder, and restart Vite after editing. The embed key is necessarily sent to Google by the browser, so restrict it to Maps Embed API and your site referrer. Do not put the server Routes key in a `VITE_` variable. Vite listens on port `3001` and proxies `/api` requests to the backend on `3002`; the browser and OAuth callback use port `3001`.

Google OAuth apps in testing mode may require the user's account to be listed as a test user. Gmail scopes can also require Google verification before a public launch.

## Gmail sync and event merging

`GET /api/auth/google` starts authorization. The callback creates an HTTP-only session cookie. `GET /api/auth/status` reports the connection, `POST /api/auth/logout` disconnects, `POST /api/events/manual` saves a form entry to MongoDB and makes one targeted Gmail search, and `POST /api/gmail/sync` fetches up to 100 Gmail messages using `GMAIL_SEARCH_QUERY` (or a per-request `query`). A manual event stores its email search result, so a missing email does not trigger a repeated search. Gmail is read with `gmail.readonly` only.

Each message is parsed for confirmation text, next steps, date/time, venue, and Discord, WhatsApp, map, and other links. Each hackathon is one MongoDB document in `UniTracker.events`, keyed by account and a normalized event identity. Follow-up emails with the same event name are matched to that document and added to its `emailDetails`, `confirmationDetails`, `stages`, `links`, and `sources` arrays. Event year is considered when matching, so editions in different years remain separate. The sync request accepts `origin` and `bufferMinutes`. If a venue and origin are available, the backend adds a Google Maps route estimate and a directions link. `GET /api/events` returns the merged cards for the signed-in account.

Events have an `archived` boolean and `archivedAt` timestamp in MongoDB. Use the Archive event button after an event concludes to move it out of My Events. Archived Events is a separate view, and Restore to My Events returns a card to the active list.

OAuth access and refresh tokens remain in server memory and users need to reconnect after a backend restart. Event records persist in MongoDB. Before deploying multiple backend instances or using this with real accounts, use a shared encrypted session store and configure MongoDB authentication, network restrictions, and backups.
