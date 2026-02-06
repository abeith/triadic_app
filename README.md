# Triadic Combinations Display

This app provides a set of tools to run a group-based triadic comparison task. In a participant-facing UI three images are displays and the experimenter can highlight any two images of the triad to compare and contrast with the remaining image. In a researcher-facing UI participant labels can be annotated with timestamps and display state information. This allows the researcher to align audio transcripts of the session with the stimuli that were being displayed. 

## Quick start

This assumes that you [have node installed](https://nodejs.org/en/download) and some familiarity with the command line. 

``` sh
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

Start the server: `npm start` and open `http://localhost:3000/display` for the participant-facing UI and `http://localhost:3000/annotate` for the researcher-facing UI. If `HOST=0.0.0.0`, these views can be accessed via the LAN URL printed in the console.

Image IDs are resolved against `public/images/`. The resolver accepts integers (`1`) for files in the format `0001.jpg`, full filenames (`manually_named_file.jpg`), bare IDs (`manually_named_file`),  and tries common extensions (jpg/jpeg/png).

## Session IDs

Each `npm start` creates a new integer `session_id` (logged on startup). The ID is attached to all logged events for that server run.

## Logging & data

- SQLite DB: `data/experiment.db` (configurable).
- Events table: `state_events`.
- `reason` values:
  - `combination-view` for initial view + pair selections
  - `invalid-form` for bad/missing image IDs
- The full payload is stored in `state_json` as a fail-safe.

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
