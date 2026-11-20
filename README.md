# GardenBud 🌱

A small, private garden layout planner for friends. Live at https://normangalimski.com/gardenbud/

- No accounts: the invite link is the key. Each device remembers you with an invisible anonymous login.
- Draw any garden shape (rectangles and circles join together; cut-outs for trees, coops and furniture).
- Drag pots and beds around, notes, comments with unread badges, version history, trash, export.

## How it's built
- Static site (`index.html`, `app.js`, `styles.css`) served by GitHub Pages. No build step.
- Supabase for the database and anonymous sign-in. Settings are in `config.js`.
  The publishable key is meant to be public; row-level security in `supabase/schema.sql` protects the data.

## Setup (already done)
1. Supabase: enable anonymous sign-ins, run `supabase/schema.sql` in the SQL editor.
2. GitHub Pages: deploy from `main`, root folder.
3. The first person to join with the invite link becomes the admin (can make a new invite link).
