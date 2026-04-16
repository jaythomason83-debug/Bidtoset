# CLAUDE.md - BidToSet

## Project Overview

BidToSet is a mobile-first Progressive Web App (PWA) for keeping score in the card game Spades. It runs at **bidtoset.netlify.app** and features live SET callouts, Blind Nil tracking, configurable house rules, player analytics, and game history.

## Tech Stack

- **Framework:** React 19 (JSX, no TypeScript)
- **Bundler:** Vite 8 with `@vitejs/plugin-react`
- **PWA:** `vite-plugin-pwa` with Workbox (auto-update service worker)
- **Hosting:** Netlify (static deploy from `dist/`)
- **Styling:** All inline styles (no CSS framework, no CSS modules)
- **State:** React `useState`/`useEffect` with `localStorage` persistence
- **Package manager:** npm

## Repository Structure

```
.
├── index.html            # Vite entry point
├── package.json          # Dependencies and scripts
├── vite.config.js        # Vite + PWA manifest config
├── netlify.toml          # Netlify build config (Node 22, --legacy-peer-deps)
└── src/
    ├── main.jsx          # React root mount (StrictMode)
    ├── App.jsx           # Entire application (~1600 lines, single file)
    └── index.css         # Base styles, CSS variables, dark mode
```

### App.jsx Organization

The entire app lives in `src/App.jsx`. It is organized with comment section headers:

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| Constants | 1-20 | Game rules defaults, color palette, localStorage keys |
| History Storage | 22-51 | `loadHistory()`, `saveGameToHistory()`, `buildGameRecord()` |
| Player Analytics Engine | 53-155 | `buildPlayerStats()` - cross-game player statistics |
| Game Summary Analytics | 157-230 | `buildGameSummary()` - MVP, sandbagger detection |
| Settings | 232-251 | `loadSettings()`, `saveSettings()`, `DEFAULT_SETTINGS` |
| Auto-split | 253-272 | Team name parser ("Jay and Debbie" -> two player names) |
| Scoring | 274-359 | `scoreTeam()`, bid validation, SET detection |
| State | 361-398 | `blank()`, `newGame()`, `load()`, `save()` |
| Nil helpers | 400-426 | Nil state cycling (off -> NIL -> BLIND NIL), button styles |
| EditableName | 428-463 | Inline-editable text component |
| PlayerRow | 465-502 | Per-player bid/tricks/nil input row |
| TeamCard | 504-560 | Team container with bid summary, SET alerts |
| ResultCard | 562-586 | Round result display |
| GameSummaryCard | 588-688 | End-of-game modal with MVP, bags, sandbagger callouts |
| HistoryScreen | 690-800 | Past games list with drill-down |
| StatsScreen | 802-907 | Player analytics dashboard (win rate, bid accuracy, etc.) |
| SettingsScreen | 909-1021 | House rules configuration, tip jar |
| OnboardingOverlay | 1023-1290 | First-visit tutorial carousel |
| Main App | 1292-1629 | Root `App` component, game loop, round scoring |

## Commands

```bash
npm run dev       # Start Vite dev server (HMR)
npm run build     # Production build to dist/
npm run preview   # Preview production build locally
npm run lint      # Run ESLint
```

### Netlify Build

The production build uses `npm install --legacy-peer-deps && npm run build` (configured in `netlify.toml`). The `--legacy-peer-deps` flag is required due to peer dependency constraints.

## Key Concepts

### Game Rules (Configurable via Settings)

| Rule | Default | Options |
|------|---------|---------|
| Win score | 500 | 250, 300, 350, 400, 500 |
| Lose score | -200 | None, -100, -150, -200, -300 |
| Bag limit | 10 | 5, 7, 10 |
| Bag penalty | -100 | -50, -100, -150 |
| Min team bid | 2 | 1 (off), 2, 3, 4 |

Rules are locked once the first round is scored. They reset with a new game.

### Scoring Logic (`scoreTeam()`)

- Normal bid: made = bid x 10 + overtricks as bags; set (under bid) = -bid x 10
- Nil: success = +100, failure = -100 (tricks become bags)
- Blind Nil: success = +200, failure = -200
- Bag overflow: accumulate across rounds, penalty applied when reaching bag limit
- Total tricks across both teams must equal exactly 13

### State Persistence

Three independent localStorage keys:
- `spades_v13` - Current game state
- `spades_history_v1` - Completed game history (max 50 games)
- `spades_settings_v1` - House rules
- `bidtoset_onboarded_v1` - Onboarding completion flag

### Player Analytics

Player stats are computed from game history and include:
- **Bid accuracy** - percentage of rounds where tricks exactly matched bid
- **Sandbag rate** - percentage of rounds with overtricks (flagged at >=30%)
- **Dead Weight Index** - player's share of team tricks (<40% = dead weight, >60% = heavy lifter)
- **MVP score** - weighted 65% bid accuracy + 35% points contribution

## Architecture Notes

- **Single-file app**: All components and logic are in `App.jsx`. There are no separate component files, no routing library, and no state management library.
- **Inline styles**: All styling is done via inline `style` objects. Color constants are defined at the top of `App.jsx`. The only CSS file (`index.css`) handles base resets and CSS custom properties for light/dark mode.
- **No TypeScript**: The project uses plain JSX. Type annotations are not used.
- **No test framework**: There are no tests currently.
- **Functional components only**: All components use React hooks (`useState`, `useEffect`, `useRef`).
- **`Object.assign` pattern**: The codebase uses `Object.assign({}, ...)` for immutable state updates instead of spread syntax in many places.

## Conventions

- **Function declarations over arrows**: Most functions use `function` keyword syntax, not arrow functions.
- **Inline styles**: New UI should use inline style objects consistent with the existing pattern. Use the color constants (`GOLD`, `RED`, `BLUE`, `GREEN`, `ORANGE`, `BG`, `DIM`, `PURPLE`).
- **Comment section headers**: Use the `// --- Section Name ---` comment pattern to delineate logical sections.
- **localStorage error handling**: All localStorage access is wrapped in try/catch with silent failure.
- **No external state library**: State is managed via React hooks and passed as props.
- **Georgia serif font**: The app uses `Georgia, serif` as its primary UI font family.

## Color Palette

| Name | Hex | Usage |
|------|-----|-------|
| GOLD | `#c8a84e` | Primary accent, team names, scores |
| RED | `#e05c5c` | Errors, negative scores, SET alerts |
| BLUE | `#00bfff` | Blind Nil indicators |
| GREEN | `#6dbf8e` | Success, positive results |
| ORANGE | `#e8943a` | SET warnings, bag alerts |
| BG | `#090d1b` | App background |
| DIM | `#080c18` | Dark text on colored buttons |
| PURPLE | `#9b59b6` | Accent (defined but rarely used) |

## PWA Configuration

The app is installable as a PWA via `vite-plugin-pwa`:
- Service worker: Workbox with `autoUpdate` registration
- Manifest: standalone display, portrait orientation
- Icons: SVG-based (`icons.svg`, `favicon.svg`)
- Caching: all JS, CSS, HTML, and SVG files
