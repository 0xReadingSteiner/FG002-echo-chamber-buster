# Echo Chamber Buster — Privacy Policy

*Effective date: 2026-09-01*

Echo Chamber Buster is a read-only analysis tool. Its purpose is to help
people evaluate whether a Reddit account's public posting history matches
patterns commonly seen in bot and astroturf accounts.

## Data the extension collects

**None.** The extension does not collect, transmit, or sell any personal
data. There is no analytics, no telemetry, no remote logging, and no
server operated by this project.

## Data the extension reads

- **Public Reddit content** for usernames visible on the page you are
  viewing (post/comment text, timestamps, subreddit names, karma and
  account-age data shown on public profiles).
- **Public archive copies** of that same content from third-party
  archives (arctic-shift.photon-reddit.com, api.pullpush.io).

## Data stored locally

Scan results are cached **only in your browser** (IndexedDB, extension
origin), so re-opening the same page does not re-fetch public archives.
Cached entries expire after 7 days. Clearing your browser data removes
all cached results.

The same policy applies to the command-line batch scanner in `cli/`:
it reads only public archives and writes only the local files you direct
it to.

## What the extension does not do

- It does not read or modify anything you write on Reddit.
- It does not access your Reddit account, credentials, or private data.
- It does not contact any server other than Reddit's own public
  endpoints and the two public archives listed above.

## Accuracy disclaimer

Scores are heuristic likelihood estimates computed from public data.
They are not proof of identity, intent, or wrongdoing, and should be
verified by a human before any action is taken.

## Contact

For questions about this policy or the extension, contact the project
maintainer (this file ships with the extension source).
