# Civ 5 Draft — online (2 players)

Open the site -> it adds `?s=<id>` to the URL and you are Player 1. Click **Copy invite link**,
send it; whoever opens it first is Player 2 (a third visitor is a read-only spectator).
Both players can change bans / count / Roll / Reroll. The opponent's pick stays hidden until you have both picked.

## Run locally
    npm install
    npm start          # http://localhost:3000

Share it without deploying: `cloudflared tunnel --url http://localhost:3000` (or ngrok).

## Deploy free on Render
1. Put this folder in a GitHub repo.
2. Render -> New -> Web Service -> pick the repo.
   Runtime Node, Build `npm install`, Start `npm start`, Instance type Free.
3. Open the `https://<name>.onrender.com` URL. WebSockets work over wss:// automatically.

Free tier notes: the service sleeps after ~15 min idle (first visit takes up to a minute),
and sessions live in memory, so they are lost on sleep/restart.
