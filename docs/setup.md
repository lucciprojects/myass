# Local setup

## 1. Install dependencies

```bash
pnpm install
```

## 2. Start MySQL

```bash
docker compose up -d mysql
```

Or point `DATABASE_URL` at an existing MySQL instance.

## 3. Environment

```bash
cp .env.example .env
```

## 4. Push the schema

```bash
pnpm db:push
```

## 5. Run everything

```bash
pnpm dev
```

The initial apps are:

- Web: http://localhost:3000
- API: http://localhost:3001/health
- Simulator: ws://localhost:3002

The next step is wiring the API's device service to the simulator WebSocket so UI parameter mutations travel through the full device protocol.
