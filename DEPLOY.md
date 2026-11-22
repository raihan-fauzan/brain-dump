# Deploying

The app is plain static files, so any HTTPS host works. GitHub Pages is the
shortest path from here: free, HTTPS (required for the service worker and for
"Install app"), and it serves from a subpath, which the app already handles
(`start_url: "./"`, relative script paths, `sw.js` registered relatively).

## 1. Create the remote

The repo already exists locally on `main` with one commit. On GitHub, create an
empty repository named `brain-dump` — **no** README, licence, or `.gitignore`
(you already have them, and an initialised repo makes the first push conflict).

```bash
git remote add origin https://github.com/<your-user>/brain-dump.git
git push -u origin main
```

## 2. Turn on Pages

Repository → **Settings** → **Pages** → *Source*: **Deploy from a branch** →
Branch: **main**, folder **/ (root)** → **Save**.

First build takes a minute or two. The URL is:

```
https://<your-user>.github.io/brain-dump/
```

The folder layout matters: `index.html` must stay at the repo root (not in a
`docs/` or `dist/` folder) for this to work as-is.

## 3. Install it on the tablet

Open the Pages URL in Chrome on the tablet:

- Chrome menu (⋮) → **Add to Home screen** → **Install**
- It opens standalone, full screen, no browser chrome.

Then test the part that matters:

1. Turn off Wi-Fi and data. Reopen the app from the home screen. It should still
   load and still show your notes (service worker + IndexedDB).
2. Add a dump while offline. It saves.
3. Process it while still offline. You should get a readable error, and the note
   should be untouched.

If step 1 fails, the service worker didn't install — almost always because the
page is being served over plain `http://`, which is not a secure context.

## 4. Updating

```bash
git add -A && git commit -m "..." && git push
```

Pages rebuilds in under a minute. The service worker is network-first, so the
next load after a change picks up the new files; you don't have to clear
anything. If you're offline with a stale shell, reload once when you're back.

## Notes on this specific app

- **Notes live in the browser, not in the repo.** Nothing you capture is ever
  uploaded anywhere. The repo is only code. A public repo leaks nothing personal.
- **Never commit your API key.** It lives in `localStorage` on each device and is
  never part of the build.
- **Pages on a private repo needs a paid plan**; on a public repo it's free. Since
  only code is public, public is usually fine here.
- **Each device is its own dataset.** Installing on the tablet and on desktop
  gives you two independent note stores. Moving notes between them is
  Settings → Export ZIP on one, Import ZIP on the other.

## Alternatives, if Pages is inconvenient

| Host | How | Caveat |
| --- | --- | --- |
| Netlify | Drag the folder into the deploy box | gives you a random URL |
| Cloudflare Pages | Connect the repo, no build command, output `/` | same idea, faster edge |
| Vercel | Import repo, framework "Other" | fine, more config |
| Own LAN | `node scripts/serve.js` on a machine that stays on | `http://192.168.x.x` is **not** a secure context: no install, no offline |

The LAN option is the one to avoid for daily tablet use — it works, but you lose
the two features that make this app worth installing.
