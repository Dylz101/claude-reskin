# Claude Reskin

A desktop app for claude.ai with up to three chats side by side, your own primary, secondary and accent colours, and heading and body font menus. The look follows the Claude Reskin mockup: lowercase labels, numbered sections, hairline rules and square corners.

Each pane is the real claude.ai page, so everything claude.ai does keeps working: projects, artifacts, Claude Code, file uploads, voice dictation, tools and connectors, extended thinking, sharing and settings. The app adds a frame around it and restyles it with CSS.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

1. Download this folder, either with `git clone https://github.com/Dylz101/claude-reskin.git` or as a zip from the green Code button on GitHub. Open a terminal in it and install the dependencies:

   ```bash
   npm install
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Sign in to claude.ai in the first pane. Email sign-in works everywhere. Google sign-in opens in a small pop-up window.
4. In claude.ai, open Settings › Appearance and set Color mode to **Match System**. The app's light/dark switch then controls claude.ai's own pages too.
5. Your chats appear in the app's sidebar a few seconds after you sign in. Open `code` once in a pane and your Claude Code sessions appear too.

To build an installable app instead (`.dmg`, `.exe` or `.AppImage` in `dist/`), run one of these on the matching system:

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

```bash
npm run dist:linux
```

The builds are unsigned, so macOS and Windows will warn the first time you open them.

## Using it

| To | Do this |
|---|---|
| Open a chat in the focused pane | Click its title in the sidebar |
| See your Claude Code sessions | Open `code` in a pane. While the focused pane is in Code, the sidebar lists sessions instead of chats |
| Open a chat beside the others | Click the split icon next to its title, or right-click a claude.ai link › Open in new pane |
| Add an empty pane | `split` in the top bar, the `add pane` strip, or Ctrl/Cmd+\ |
| Close a pane | × in its header, or Ctrl/Cmd+W |
| Keep only one pane | The expand icon in its header, `single` in the top bar, or Ctrl/Cmd+Shift+\ |
| Switch panes | Click inside one, or Ctrl/Cmd+1, 2, 3 |
| New chat in the focused pane | `new chat`, or Ctrl/Cmd+N |
| Change colours and fonts | `appearance`, or Ctrl/Cmd+, |
| Hide the app sidebar | Ctrl/Cmd+B |
| Zoom the focused pane | Ctrl/Cmd+= and Ctrl/Cmd+- |

Open panes, colours, fonts and window size are saved and restored on the next launch.

## Updates

You install the app once. After that it updates itself from [github.com/Dylz101/claude-reskin](https://github.com/Dylz101/claude-reskin):

- It checks five seconds after launch, then every ten minutes. Click the version in the top bar, or choose File › Check for updates, to check now.
- Changes to the look, the frame and fonts apply while the app runs. The top bar shows "updated to v…".
- Changes to the app's core download in the background. The top bar then shows **restart to update**. Your panes reopen after the restart.
- Every downloaded file is checked against the SHA-256 listed in `manifest.json` before it's used. A file that doesn't match is ignored and the app keeps running the copy it has.
- Downloads are kept in the app's data folder under `payload/`. Deleting that folder returns the app to the copy you installed.

`bootstrap.js` (the launcher) is the one file that can't update itself. If a future update needs a new launcher, the top bar says "needs a reinstall".

To publish an update: make the change, run `npm test`, run `npm run release` (bumps the version and rewrites `manifest.json`), then commit and push to `main`. `npm run dev` starts the app from this folder without the updater.

## Fonts

Foun and CS Genio Mono are paid fonts, so they aren't included. Until you add them, Antonio and Space Mono (both under the SIL Open Font License, in `fonts/`) stand in.

To use them, either install them on your computer, or open appearance › `add font files…` and pick the `.otf`, `.ttf`, `.woff` or `.woff2` files. Files whose names start with `Foun` or `CSGenioMono` are picked up by the default font settings automatically. Any other font file appears under "your font files" in both menus.

`list installed fonts` adds every font on your computer to the menus. If your system doesn't allow that, type a font's name and press `use for headings` or `use for body`.

## How it works

- `main.js` creates the window. Each pane is an Electron `WebContentsView` loading claude.ai with the shared sign-in session. Links to other sites open in your browser, and claude.ai links that ask for a new window open as a new pane.
- `shell/` is the frame: top bar, sidebar and appearance panel. It reports where each pane should sit, and `main.js` places the claude.ai views there.
- `theme.js` turns your settings into the frame's colours and into a stylesheet injected into every claude.ai pane. It overrides claude.ai's CSS variables (`--bg-*`, `--text-*`, `--accent-*`, `--cds-*`, `--df-*` and the font variables).
- `sidebar-data.js` fetches the sidebar's lists with the same requests claude.ai's own sidebar makes, run inside a signed-in pane. It reads the organization claude.ai is using (its `lastActiveOrg` cookie, or the organization claude.ai's own requests name), loads recents 30 at a time with starred chats listed apart, and refreshes whenever claude.ai creates, sends to, renames, stars or deletes a chat. For Claude Code it replays the request claude.ai's Code page makes for its session list, and remembers it (without credentials) for the next launch.

## When claude.ai changes

claude.ai updates its interface often. If something looks off after an update:

- **A colour didn't change.** Open View › Developer tools for pane, inspect the element, find the `var(--…)` it uses, and add that variable to `claudeCSS()` in `theme.js`.
- **The chat list says it couldn't load.** claude.ai's own sidebar still works: press `show claude's sidebar`, or untick appearance › layout › "hide claude.ai's own sidebar inside panes".
- **claude.ai's sidebar shows up twice, or leaves a gap.** Toggle the same setting.

Run `npm test` after editing `theme.js` or `bootstrap.js`. To preview the frame in a browser without Electron, run `node dev/preview.js` (needs Playwright).

## Limits

- This is an unofficial wrapper, not affiliated with Anthropic. It uses your normal claude.ai account and session.
- The sidebar's search covers the chats it has loaded so far (scroll to load more). Press Enter in its search box to search all of them on claude.ai.
- The Claude Code session list needs one visit to `code` before it can load, because it reuses claude.ai's own request for that list. If that request carries a sign-in token, the app keeps the token in memory only, so the visit is needed again after each launch.
- There's no find-in-page (Ctrl/Cmd+F) yet.
