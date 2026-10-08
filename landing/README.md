# Agonas Landing Page

A single-page, dependency-free landing page for **Agonas**, built with plain semantic HTML, vanilla CSS, and minimal vanilla JavaScript.

## Tech & Architecture
- **Zero build step:** Pure static files (`index.html`, `style.css`, `script.js`).
- **No external JavaScript libraries:** Uses native DOM APIs and the Web Clipboard API with fallback.
- **Theme-aware:** System font stack, responsive from 360px up without horizontal scroll, with automatic light and dark mode via `prefers-color-scheme`.
- **Accessible:** Semantic landmarks (`<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`), single `<h1>`, visible focus states, AA contrast, keyboard-navigable tabs, and `prefers-reduced-motion` compliance.

---

## Local Preview

### Option 1: Open Directly
You can open `index.html` directly in any web browser without running a server:
```bash
# Windows
start landing/index.html

# macOS
open landing/index.html

# Linux
xdg-open landing/index.html
```

### Option 2: Local HTTP Server
Run Python's built-in HTTP server from the repository root:
```bash
python -m http.server 8088 --directory landing
```
Then visit `http://localhost:8088` in your browser.

---

## Deploying to GitHub Pages

### Method A: Deploy from a Branch (Recommended for Subfolder)
1. In your GitHub repository, navigate to **Settings** &rarr; **Pages**.
2. Under **Build and deployment** &rarr; **Source**, select **Deploy from a branch**.
3. If using root `/docs` or custom branch:
   - You can push the `landing/` directory to a dedicated `gh-pages` branch:
     ```bash
     git subtree push --prefix landing origin gh-pages
     ```
   - Then select branch `gh-pages` and folder `/ (root)` in GitHub Pages settings.

### Method B: GitHub Actions Workflow
Create `.github/workflows/deploy-pages.yml`:
```yaml
name: Deploy Landing Page to GitHub Pages

on:
  push:
    branches: ["master"]
    paths:
      - "landing/**"

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: 'landing'

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```
Once deployed, the site will be live at `https://<owner>.github.io/<repo>/`.
