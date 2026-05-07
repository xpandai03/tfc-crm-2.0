# scripts/

Ad-hoc maintenance scripts. Most are one-off; commit them so the work is
reproducible.

## csv-to-providers-xlsx.mjs

Converts a CSV exported from Sandra's Provider Skills Spreadsheet into the
xlsx that the CRM parser expects (`data/Provider Skills Spreadsheet.xlsx`,
sheet name `Current`). Used whenever Sandra delivers a fresh roster.

```sh
# Basic — writes to the default path
node scripts/csv-to-providers-xlsx.mjs path/to/sandra-export.csv

# Custom output path
node scripts/csv-to-providers-xlsx.mjs path/to/sandra-export.csv path/to/out.xlsx
```

Round-trips through `xlsx/xlsx.mjs` and emits a sanity-check log line on
exit (`row 1, col 2` should read `"Accepting Client"` for the May 2026
schema). The parser at `server/routes.ts:2818` reads the result.

If Sandra changes the column layout again (added/removed columns), the
parser will need updates — see the column-mapping comment block at the top
of the parser, and the audit at `AUDIT-provider-backend.md`.

## down-activity-created-at.ts / migrate-to-postgres.ts / test-status-tracking.ts / transform-csv.ts

Older one-off scripts; not maintained. Skim before reusing.
