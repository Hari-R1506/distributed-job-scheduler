# Setup guide

Written for someone who hasn't used Docker before. Follow it top to bottom.

**Total time:** ~10 minutes, most of it waiting for downloads.

---

## Part 0 — What Docker is actually doing here (2 min read)

Skip this if you just want commands, but it makes the rest make sense.

This project needs **six programs running at once**:

| | What it does |
|---|---|
| PostgreSQL | The database |
| API | Handles web requests |
| Scheduler | Fires cron jobs, cleans up after crashes |
| Worker ×3 | Actually run the jobs — three separate copies |
| Dashboard | The web UI you look at |

Installing and starting five things by hand, in the right order, with the right
settings, is tedious and easy to get wrong. Docker does it for you.

Three words you'll see:

- **Image** — a frozen snapshot of a program plus everything it needs to run. Like a `.zip` of an entire mini-computer. You *build* an image once.
- **Container** — a running copy of an image. You can start three containers from one image; they don't interfere with each other. That's how we get three workers.
- **Compose** — a file (`docker-compose.yml`) that describes all your containers and how they connect, so one command starts everything.

The key intuition: **containers are disposable.** Deleting one and starting a
fresh one is normal and safe. The only thing that survives is data we explicitly
tell Docker to keep (here, the database, in something called a *volume*).

---

## Part 1 — Fix Docker on your machine

> **This is your current blocker.** Your Docker Desktop app is running and WSL is
> fine, but a background Windows service called **`com.docker.service`** is
> stopped. That service is what creates the connection point Docker commands talk
> to. Without it every command fails with:
>
> ```
> failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
> ```
>
> Nothing is broken or misconfigured — the service just isn't started, and
> starting it needs Administrator rights.

### Do this

1. **Quit Docker Desktop completely.** Right-click the whale icon in your system
   tray (bottom-right, you may need to click the `^` arrow) → **Quit Docker
   Desktop**. Wait for the icon to disappear.

2. **Find Docker Desktop in the Start menu.**

3. **Right-click it → Run as administrator.** Click **Yes** on the prompt.

4. **Wait.** First start takes 1–3 minutes. Watch the whale icon in the tray:
   - *animated / wobbling* = still starting
   - *steady* = ready
   
   Open the Docker Desktop window and look at the bottom-left corner. Wait for it
   to say **"Engine running"** in green.

5. **Verify** — open a new terminal in `D:\Codity`:

```bash
docker version
```

If the **Server:** section prints a version (not an error), the engine is up.
That is the check that matters.

> **Avoid `docker run hello-world` as your first test.** It needs to *download*
> an image from the internet, so it fails on a slow or blocked connection even
> when Docker itself is perfectly fine — you get a confusing
> `TLS handshake timeout` and think Docker is broken when it isn't. `docker version`
> asks only your local engine and gives a clean answer.

> **Make this permanent (optional).** So you don't repeat this every reboot:
> open Docker Desktop → ⚙️ **Settings** → **General** → tick
> **"Start Docker Desktop when you sign in"**. If it still stops, open
> **Services** (Win+R → `services.msc`), find **Docker Desktop Service**,
> right-click → **Properties** → set **Startup type: Automatic** → **Apply**.

**Do not continue until `docker version` prints a Server section.** Everything
below depends on it.

---

## Part 2 — One-time project setup

Open a terminal in `D:\Codity`. Run these one at a time.

### 1. Create your config file

```bash
cp .env.example .env
```

This copies the example settings into a real config file. `.env` holds
passwords and ports; it's git-ignored so your secrets never get committed. The
defaults work as-is for local development.

### 2. Install dependencies

```bash
npm install
```

Downloads the project's libraries into `node_modules/`. Takes 1–2 minutes.

You may see a warning about **install scripts**. Approve the ones this project
genuinely needs (they compile native code):

```bash
npm approve-scripts prisma @prisma/client @prisma/engines esbuild argon2
```

### 3. Generate the database client

```bash
npm run db:generate
```

Reads the database schema and generates typed code for talking to it. If you
skip this you'll get **"@prisma/client did not initialize yet"** later.

---

## Part 3 — Start everything

```bash
docker compose up -d --build
```

Breaking that down:

- `docker compose` — use the `docker-compose.yml` file
- `up` — start all the services in it
- `-d` — "detached": run in the background and give the terminal back
- `--build` — build the images from our source code first

**The first run takes 3–5 minutes** — it downloads Postgres and Node, then
compiles the project. Later runs take seconds because Docker caches the work.

You'll see a lot of scrolling output. That's normal.

### Check it worked

```bash
docker compose ps
```

Expected — six containers, all `Up`:

```
NAME            STATUS
djs-postgres    Up 2 minutes (healthy)
djs-api         Up 1 minute (healthy)
djs-scheduler   Up 1 minute
djs-worker-1    Up 1 minute
djs-worker-2    Up 1 minute
djs-worker-3    Up 1 minute
djs-web         Up 1 minute
```

`(healthy)` on postgres means Docker checked the database is genuinely accepting
connections, not just that the process started.

> **See a container `Restarting`?** It's crash-looping. Read its error:
> `docker compose logs api`. Jump to Troubleshooting below.

### Load the demo data

```bash
npm run seed
```

Creates a demo organization, 4 queues, 2 cron schedules and ~58 jobs. Prints an
API key at the end — **copy it now**, it's shown once and never again (only its
hash is stored, so nobody can recover it from the database, including you).

---

## Part 4 — See it working

### Open the dashboard

**http://localhost:5173**

Sign in with the demo account the seed created, or click **"No account? Create
one"** to make your own.

> ⚠️ **The seeded `demo@codity.ai` account cannot log in on purpose.** The seed
> writes a deliberately unusable password marker rather than a real hash —
> demo credentials that actually work are how a demo database ends up
> reachable in production. Create your own account instead.
>
> Note that a brand-new account gets its **own organization**, which starts
> empty. The seeded queues belong to the demo org, so to see them you want the
> account you register to be the *only* one, or create your own queues. This is
> tenant isolation working, not a bug.

Five pages: **Overview** (stat cards + throughput chart), **Queues**
(pause/resume), **Jobs** (filterable explorer), **Workers** (live health), and
**Dead letter** (failures grouped by error signature, with replay).

### Open the API documentation

**http://localhost:3000/docs**

An interactive page listing all 57 endpoints. You can call them from the browser
with the "Try it out" button.

### Watch the jobs drain

```bash
docker exec -it djs-postgres psql -U djs -d job_scheduler -c "SELECT status, count(*) FROM jobs GROUP BY status ORDER BY 2 DESC;"
```

`docker exec` means "run a command *inside* a running container". Here it runs
`psql` (the Postgres client) inside the database container, so you don't need
Postgres installed on Windows at all.

Within ~15 seconds of seeding you should see roughly:

```
   status    | count
-------------+-------
 COMPLETED   |    50
 SCHEDULED   |     5     ← delayed jobs, correctly still waiting
 DEAD_LETTER |     3     ← the 3 seeded to fail permanently
```

Those 3 dead-lettered jobs are *supposed* to fail. They prove the failure path
works end to end.

### Watch the logs live

```bash
docker compose logs -f worker-1
```

`-f` means "follow" — keep printing as new lines arrive. **Press `Ctrl+C` to
stop watching.** That stops the *log viewer*, not the container.

---

## Part 5 — The demo worth showing

This is the part that demonstrates what the project is actually for.

### Kill a worker while it's working

Open **http://localhost:5173/workers** in your browser first, so you can watch
it happen. Then:

```bash
docker kill djs-worker-2
```

`docker kill` sends **SIGKILL** — instant death, no cleanup, no chance to save
anything. It's the harshest thing you can do to a program, and it simulates a
server losing power.

Now watch the system heal itself:

```bash
docker compose logs -f scheduler
```

Over the next minute:

- **~30 seconds** — the worker misses 6 heartbeats and is marked `DEAD`
- **~60 seconds** — its jobs' *leases* expire; the reaper reclaims them, marks those attempts `ABANDONED`, and puts the jobs back in the queue
- immediately after — workers 1 and 3 pick them up and finish them

**Nothing is lost and nobody intervened.** Press `Ctrl+C` to stop watching.

Bring it back:

```bash
docker compose start worker-2
```

### Compare: a polite shutdown

```bash
docker stop djs-worker-1
```

`docker stop` sends **SIGTERM** — "please finish up". The worker stops taking
new jobs, finishes the ones it's holding, then exits cleanly. It takes a few
seconds instead of a minute, and no job is ever retried.

That contrast — `kill` vs `stop` — is the whole reliability story in two
commands.

---

## Part 6 — Everyday commands

| Command | What it does |
|---|---|
| `docker compose ps` | What's running |
| `docker compose logs -f` | Watch all logs (`Ctrl+C` to stop) |
| `docker compose logs api` | Just the API's logs |
| `docker compose restart api` | Restart one service |
| `docker compose stop` | Stop everything, **keep the data** |
| `docker compose start` | Start it again |
| `docker compose down` | Stop and delete the containers (data survives) |
| `docker compose down -v` | ⚠️ Also **delete the database**. Full reset. |
| `docker compose up -d --build` | Rebuild after changing code |

There's also a `Makefile` with shortcuts — `make up`, `make seed`, `make logs`,
`make kill-worker`. Run `make help` to list them.

### After you change code

Containers run a *snapshot* of your code taken at build time. Editing a file on
your machine does **not** change what's running inside a container. Rebuild:

```bash
docker compose up -d --build
```

---

## Part 7 — Running the tests

The tests don't need the full stack, just Docker available.

```bash
npm run test:unit
```

85 tests, ~1 second, no database. Covers retry maths, the job state machine, and
timezone handling.

```bash
npm run test:race
```

**The important one.** Starts a real throwaway Postgres and runs 20 workers
against 500 jobs simultaneously, proving no job is ever executed twice.

Make it much faster by reusing the database you already have running:

```bash
TEST_DATABASE_URL="postgresql://djs:djs_dev_password@localhost:5432/job_scheduler?schema=public" npm run test:race
```

---

## Troubleshooting

### `failed to connect to the docker API at npipe:...dockerDesktopLinuxEngine`

Docker's engine isn't running. Go back to **Part 1** — quit Docker Desktop
completely and restart it **as administrator**.

### Docker Desktop keeps stopping by itself

Seen on this machine more than once: the app is running, WSL is fine, but
`com.docker.service` drops back to **Stopped** and every command fails again.

The durable fix is to stop relying on the app to start that service:

1. Win+R → `services.msc` → find **Docker Desktop Service**
2. Right-click → **Properties**
3. **Startup type: Automatic** → **Apply** → **Start**

Then in Docker Desktop → ⚙️ **Settings** → **General**, tick **"Start Docker
Desktop when you sign in"**.

Until that is set, you will need to launch Docker Desktop **as administrator**
after each reboot.

### `TLS handshake timeout` when pulling an image

Docker is working; it just can't reach Docker Hub right now. This is almost
always transient — internet hiccup, slow DNS, or a corporate network.

**Try again first.** It usually succeeds on the second attempt:

```bash
docker pull node:22-alpine
```

If it keeps failing, point Docker at a public DNS server: Docker Desktop →
⚙️ **Settings** → **Resources** → **Network** → set DNS to `8.8.8.8`, then
**Apply & restart**.

Note that once an image is downloaded it is **cached on your machine**, so this
error only affects images you don't already have. Check what you have with
`docker images`.

### `port is already allocated`

Something else on your machine is using port 3000 or 5432. Open `.env` and
change the number:

```
API_PORT=3001
POSTGRES_PORT=5433
```

Then `docker compose down` and `docker compose up -d`.

### A container says `Restarting`

It's crashing on startup, over and over. Read the actual error:

```bash
docker compose logs api --tail 30
```

The `--tail 30` shows only the last 30 lines, which is usually where the error is.

### `@prisma/client did not initialize yet`

```bash
npm run db:generate
```

### Worker exits with "No organization exists yet"

Workers attach to an existing organization; they don't create one. Run:

```bash
npm run seed
```

### `P1001: Can't reach database server`

Postgres isn't up yet. Check with `docker compose ps` — it should say
`(healthy)`, which can take ~10 seconds after starting. If it says `Exited`,
read `docker compose logs postgres`.

### The workers vanish from the `workers` table

If you reset by running `TRUNCATE organizations CASCADE` in psql, that cascade
deletes the `workers` rows too — leaving the running containers holding worker
ids that no longer exist. They keep running but stop doing useful work.

Restart them so they re-register:

```bash
docker compose restart worker-1 worker-2 worker-3 scheduler
```

This is why the proper reset is `docker compose down -v`, not a manual
`TRUNCATE`.

### A queue I created returns 404

Check which organization it belongs to. A worker serves **one organization**
(the oldest one it finds), and a login token only sees organizations you are a
member of. A queue in another org is invisible — deliberately returning `404`
rather than `403`, so the API cannot be used to probe which ids exist.

### Everything is confusing and I want to start over

```bash
docker compose down -v
docker compose up -d --build
npm run seed
```

⚠️ `-v` deletes the database volume. Every job, user and queue is gone. That's
fine here — `npm run seed` recreates the demo data. Never run `-v` against
something you care about.

### Docker is using a lot of disk

Images and stopped containers accumulate. Clean up:

```bash
docker system prune
```

Add `-a` to also delete images not currently used by a container — that frees
more space but means re-downloading next time.

---

## Mental model, in one table

| You type | What actually happens |
|---|---|
| `docker compose up -d` | Docker reads `docker-compose.yml`, builds/downloads images, starts a container per service, wires them onto a private network so they can reach each other by name |
| `docker compose ps` | Lists containers and their state |
| `docker compose logs X` | Prints what service X wrote to its console |
| `docker exec -it X cmd` | Runs `cmd` *inside* container X |
| `docker stop X` | Politely asks X to shut down (SIGTERM) |
| `docker kill X` | Terminates X instantly (SIGKILL) |
| `docker compose down` | Deletes the containers; the data volume survives |
| `docker compose down -v` | Deletes the containers **and** the data |

The one thing worth remembering: **containers are disposable, volumes are not.**
Delete and recreate containers freely. Only `-v` destroys data.
