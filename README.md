# Triadic Combinations Display

This app provides a set of tools to run a group-based triadic comparison task. In a participant-facing UI three images are displays and the experimenter can highlight any two images of the triad to compare and contrast with the remaining image. In a researcher-facing UI participant labels can be annotated with timestamps and display state information. This allows the researcher to align audio transcripts of the session with the stimuli that were being displayed.

## Quick start

This assumes that you [have node installed](https://nodejs.org/en/download) and some familiarity with the command line.

```sh
cd path/to/your/projects
git clone https://github.com/abeith/triadic_app.git
cd triadic app
npm install
```

### Environment variables

Optional values:

- `PORT` (default 3000)
- `HOST` (default `127.0.0.1`, use `0.0.0.0` for LAN access)
- `IMAGES_DIR` (default `public/images`)
- `DB_FILE` (default `data/experiment.db`)

If you need to change any of these values, copy `.env.example` to `.env`.

### Adding images

You can add image URLs to a file named `.imageurls` (see `.imageurls.example`) and run `npm run import-and-rename`. Alternatively you can copy images to `public/images/` and run `npm run rename-image` to rename files.

### Printing images

Print the images with IDs (essential so physical cards match logged IDs): `npm run print-images -- --layout 2x2`.
Use `.printignore` or `.printinclude` to exclude or include specific IDs when generating the print grid. Layout options include `1x2`, `2x2`, and `2x3`.

### Launching a session

Start the server: `npm start` and open `http://localhost:3000/display` for the participant-facing UI, `http://localhost:3000/annotate` for the researcher-facing UI, and `http://localhost:3000/constructs` for the construct list demo. If `HOST=0.0.0.0`, these views can be accessed via the LAN URL printed in the console. The participant display moves through a fixed sequence of groupings (`none -> AB|C -> AC|B -> BC|A`) using Back/Forward controls.

Image IDs are resolved against `public/images/`. The resolver accepts integers (`1`) for files in the format `0001.jpg`, full filenames (`manually_named_file.jpg`), bare IDs (`manually_named_file`), and tries common extensions (jpg/jpeg/png).

## Session IDs

Each `npm start` creates a new integer `session_id` (logged on startup). The ID is attached to all logged events for that server run.
If the configured DB file already exists, startup creates a timestamped pre-session snapshot in a sibling `snapshots/` directory before opening the live database.

## Logging & data

- SQLite DB: `data/experiment.db` (configurable).
- SQLite snapshots: `data/snapshots/` by default, named from the live DB filename plus a timestamp and lifecycle marker.
- Event tables: `state_events`, `display_events`, and `annotation_submissions` (`annotation_events` remains as legacy/compatibility logging).
- `triads` stores canonical triad image references and is linked from `display_events.triad_id` and `annotation_submissions.triad_id`.
- Streamlined annotation submissions store neutral fields `label1`, `label2`, optional `notes`, and optional `pair` (`ab|ac|bc|null`) while still retaining legacy label columns for compatibility.
- Canonical construct tables: `constructs` (core bipolar construct), `construct_relationships` (subordinate/superordinate/unspecified links), `construct_wordings` (alternate/sibling phrasings by pole), and append-only `construct_polarity_events`.
- Current construct polarity is derived from the latest `construct_polarity_events` row per construct; if no event exists it is treated as `unknown` for both labels.
- `POST /api/constructs/sync` imports constructs from `annotation_submissions` into `constructs` (idempotent via unique `origin_annotation_submission_id`). Supports `session`/`session_id` filtering and defaults to the current session.
- Run sync before reading constructs when new annotation submissions have been added.
- `GET /api/constructs` returns constructs from canonical `constructs` and supports `?limit=...`, `?session=<id>` (or `?session_id=<id>`), comma-separated or repeated session ids (for example `?session=4,6` or `?session=4&session=6`), and `?session=all`.
- `GET /constructs` performs a scoped sync on page load before rendering and shows a synced indicator in the page header.
- `POST /api/constructs/:id/polarity` appends a polarity event (`label1_polarity`, `label2_polarity`, optional `source` and `note`) without mutating existing construct rows.
- `state_events.reason` currently uses `combination-view` (display interactions) and `invalid-form` (bad/missing image IDs).
- The full payload is stored in JSON columns as a fail-safe.
- The app uses SQLite rollback journalling (`journal_mode=DELETE`, `synchronous=FULL`) so the live dataset remains centred on the configured DB file; on orderly shutdown it also writes a post-session snapshot after closing the DB connection.
- If SQLite companion files such as `-journal`, `-wal`, or `-shm` are present when a snapshot is taken, they are copied alongside the snapshot for recovery completeness.

## Scripts

- `npm run check-db -- [args]` — quick read-only session checks for `state_events`, `display_events`, `annotation_events`, and `annotation_submissions`.
- `npm run export-db -- [args]` — export `state_events` or `annotation_submissions` to JSON/CSV.
- `npm run import-images` — download image URLs listed in `.imageurls`.
- `npm run import-and-rename` — download URLs then normalise filenames to 4-digit IDs.
- `npm run rename-image` — rename non-matching image files to 4-digit IDs.
- `npm run print-images` — generate a print-ready HTML grid of images.
- `npm run export-runtime` — Experimental: Export runtime data to `runtime_exports/`.
- `npm run import-runtime` — Experimental: Import a runtime archive into the current directory.

### check-db usage

- Default (latest session, compact output): `npm run check-db`
- Specific session and limit: `npm run check-db -- --session 12 --limit 20`
- Annotation-only with raw payloads: `npm run check-db -- --table annotation --raw`
- New submission table view: `npm run check-db -- --table submission`
- Display-link timeline view: `npm run check-db -- --table display`
- Include derived normalized labels (raw remains default): `npm run check-db -- --table submission --normalized`

### export-db usage

- Default state export (JSON): `npm run export-db`
- Export submissions as CSV: `npm run export-db -- --table submission --format csv`
- Export submissions with derived normalized labels: `npm run export-db -- --table submission --normalized`
