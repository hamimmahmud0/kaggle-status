# Kaggle Status

A GNOME Shell extension that puts your Kaggle GPU/TPU quota in the top bar, across multiple accounts.

- **Combined quota ring.** One donut ring (with a percentage) sums quota over all enabled accounts. It can also show one ring per account.
- **Individual quota.** Each account has its own card in the menu with GPU and TPU bars and the weekly reset time.
- **Running sessions.** A `▶ N` badge in the panel shows how many kernels are running or queued. The menu lists them, and clicking one opens its output.
- **Kernel browser.** Browse an account's own kernels or search public ones.
- **Run with any account.** Run a kernel from one account on another account's quota.
- **Live output.** View the log, which refreshes while the session is active, and open output files.
- **Settings.** Ring size, colours, thresholds, panel position, refresh timing and more.

Tested on GNOME Shell 50. `metadata.json` lists shell versions 49, 50 and 51.

## Install

```sh
./install.sh
```

This compiles the schemas, copies `src/` to `~/.local/share/gnome-shell/extensions/kaggle-status@hamim.local`, and points the extension at the `.token/` directory in this repo (if it exists).

On Wayland, log out and back in once so GNOME Shell discovers the extension, then enable it:

```sh
gnome-extensions enable kaggle-status@hamim.local
```

Re-run `./install.sh` after any code change.

## Accounts and tokens

Put one token file per account in a directory. The default is `~/.config/kaggle-status/tokens/`; change it under Settings → General → Token directory.

Accepted formats:

- a bare Kaggle API token (`KGAT_…`)
- a `kaggle.json`-style file with `username` and `key`
- `username:key`

Tokens are read in place and never copied into settings or the extension folder. They are not logged. The username is learned from the account's kernel list, so an account needs at least one kernel before it can be a "Run with" target. Its quota shows either way.

## Using it

- **Panel:** click the indicator to open the menu.
- **Menu:** shows combined quota, per-account cards and running sessions. The refresh button re-checks everything.
- **Browse & run kernels…** opens the browser.
  1. Pick a source (an account or Public) and optionally search.
  2. Select a kernel.
  3. Choose the account under **Run with**.
  4. Press **Run**.

Running a kernel with another account reads the source (with the owner's token when available) and pushes a copy into the chosen account, which runs it there. The copy is private by default (see Settings → Kernels).

Datasets or competitions that are private to the source account may fail on the target account. The dialog warns about this where it can tell.

## How running sessions are detected

Kaggle has no "list sessions" call. Each refresh checks the session status of every account's most recent kernels, plus any run you started from the extension. The number of kernels checked per account is a setting (default 8; 0 turns detection off).

While something is running, refreshes happen more often (default every 15 s, otherwise every 60 s).

## Settings

| Page | Options |
| --- | --- |
| Accounts | Display name, colour and on/off per account |
| Panel | Combined or per-account rings, GPU/TPU/fuller, show used or left, percentage text, running badge, ring size and thickness, warning/critical thresholds, colours, panel position |
| General | Token directory, refresh intervals, kernels checked per account, finish notifications |
| Kernels | Private copies, internet access, browser page size and sort, output refresh, log font size and length |

## Project layout

```
src/
  extension.js      panel indicator and menu
  prefs.js          settings window
  lib/
    kaggleClient.js Kaggle API client (GLib/Soup, no Shell imports)
    monitor.js      accounts, polling, running-session tracking
    model.js        pure helpers (quota maths, formatting, colours)
    ring.js         Cairo donut and bar widgets
    dialogs.js      kernel browser and output viewer
  schemas/          GSettings schema
  stylesheet.css
tools/
  probe.js          check API access against a token directory
  test-model.js     unit checks for lib/model.js
install.sh
```

## Development

Check API access without the UI (prints statuses and quota only, never tokens):

```sh
gjs -m tools/probe.js "$PWD/.token"
```

Run the model checks:

```sh
gjs -m tools/test-model.js
```

Watch the shell log while testing:

```sh
journalctl -f /usr/bin/gnome-shell
```

## Notes

- The API client talks to `https://api.kaggle.com/v1/kernels.KernelsApiService/<Method>`, the same service the official `kaggle` CLI uses.
- The panel ring is modelled on [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage).
