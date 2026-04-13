# Ricerca sul progetto YAOS

Data: 2026-04-10

## Executive summary

YAOS è un sistema di sync real-time per Obsidian composto da due parti:

1. un plugin Obsidian che mantiene il vault come file locali normali;
2. un server Cloudflare Worker che sincronizza uno stato CRDT condiviso per l'intero vault.

L'idea chiave è: il testo Markdown viene sincronizzato tramite Yjs CRDT, mentre gli allegati binari vengono sincronizzati separatamente tramite Cloudflare R2. L'architettura privilegia correttezza, merge real-time e atomicità cross-file rispetto a scalabilità estrema o throughput massimo.

## Stato del repository

- Non esistono `substrate/directives/` né `substrate/traces/` preesistenti.
- Le regole operative specifiche del repository sono in `AGENTS.md`.
- Il progetto è un plugin Obsidian community (`manifest.json`) con componente server separata in `server/`.

## Struttura del repository

### Plugin Obsidian

- Entry point: `src/main.ts`
- Settings UI e configurazione: `src/settings.ts`
- Motore sync CRDT: `src/sync/vaultSync.ts`
- Bridge disco ↔ CRDT: `src/sync/diskMirror.ts`
- Sync allegati: `src/sync/blobSync.ts`
- Snapshot client: `src/sync/snapshotClient.ts`
- Capabilities server: `src/sync/serverCapabilities.ts`
- Tipi condivisi: `src/types.ts`

### Server Cloudflare

- Entry point Worker: `server/src/index.ts`
- Durable Object room: `server/src/server.ts`
- Persistenza checkpoint+journal: `server/src/chunkedDocStore.ts`
- Snapshot R2: `server/src/snapshot.ts`
- Config/auth claim: `server/src/config.ts`
- Metadati room/schema: `server/src/roomMeta.ts`
- Versioning/compatibilità: `server/src/version.ts`
- Infrastruttura: `server/wrangler.toml`

### Altra documentazione utile

- `README.md`
- `engineering/monolith.md`
- `engineering/filesystem-bridge.md`
- `engineering/checkpoint-journal.md`
- `engineering/attachment-sync.md`
- `engineering/zero-config-auth.md`
- `engineering/zero-ops-update-pipeline.md`
- `engineering/warts-and-limits.md`

## Come funziona

## Modello dati

Il plugin usa un singolo `Y.Doc` per l'intero vault (`src/sync/vaultSync.ts`). Dentro il documento ci sono mappe per:

- path → fileId
- fileId → `Y.Text`
- metadati file
- stato di sistema/schema
- riferimenti agli allegati
- metadati blob
- tombstone blob

Questo modello permette operazioni atomiche su più file, come rename di cartelle, perché l'intero vault condivide lo stesso contesto transazionale. La scelta è documentata in `engineering/monolith.md`.

## Flusso startup del plugin

In `src/main.ts` il plugin:

1. carica le impostazioni salvate;
2. genera `vaultId` e `deviceName` se mancanti;
3. registra l'handler `obsidian://yaos` per il pairing automatico;
4. carica capabilities e update manifest in background se l'host è configurato;
5. inizializza `VaultSync`, che crea:
   - `Y.Doc`
   - persistenza locale IndexedDB (`y-indexeddb`)
   - provider websocket `y-partyserver`
6. aspetta il bootstrap locale e il primo sync provider;
7. riconcilia stato su disco e stato CRDT;
8. collega gli editor aperti al CRDT.

## Plugin ↔ server

### Canale real-time

Il testo viaggia su WebSocket verso `/vault/sync/<vaultId>` usando `y-partyserver` (`src/sync/vaultSync.ts`, `server/src/server.ts`).

### HTTP API

Il server espone anche API HTTP per:

- capabilities (`/api/capabilities`)
- blob existence/upload/download
- snapshot create/list/download/restore helpers
- debug recente

## Bridge filesystem ↔ CRDT

Questa è una parte centrale del progetto. Invece di fidarsi dei timestamp dei file event, YAOS usa un modello di acknowledgement basato sul contenuto osservato (`engineering/filesystem-bridge.md`, `src/sync/diskMirror.ts`).

Principi principali:

- gli eventi disco vengono coalescati per path;
- gli import dal disco al CRDT passano da un dirty-set drain loop;
- le scritture CRDT → disco sono serializzate per path;
- la soppressione dei self-echo non è time-based ma hash-based.

Questo riduce loop, duplicati, race condition e corruzioni durante edit simultanei o modifiche esterne fatte da git, script, altri editor o agenti AI.

## Sync allegati

Gli allegati non entrano nel CRDT. Vengono gestiti come blob content-addressed:

1. il client calcola SHA-256 del file;
2. chiede al server quali hash esistono già;
3. carica via `PUT` solo i blob mancanti;
4. aggiorna il CRDT con il riferimento hash → path.

Questo vive in `src/sync/blobSync.ts` e `server/src/index.ts`. La motivazione è in `engineering/attachment-sync.md`: mantenere il testo nel CRDT ma evitare di trattare PDF, immagini e media come testo collaborativo.

## Snapshot e recovery

Se è disponibile un bucket R2, YAOS supporta:

- snapshot giornalieri automatici;
- snapshot manuali;
- listing snapshot;
- diff snapshot vs stato corrente;
- restore selettivo.

Client: `src/sync/snapshotClient.ts`
Server: `server/src/snapshot.ts`

Gli snapshot serializzano il CRDT del vault, lo comprimono e lo salvano in R2.

## Persistenza server

Il server non riscrive tutto il documento a ogni save. Usa una strategia checkpoint + journal (`engineering/checkpoint-journal.md`, `server/src/server.ts`, `server/src/chunkedDocStore.ts`):

- checkpoint completi chunked;
- delta journal appesi nel tempo;
- compattazione oltre soglie prefissate;
- validazione hash e sequencing fail-closed.

Questa è una scelta importante: corregge il problema di write amplification tipico dei backend CRDT monolitici.

## Deploy corretto

## Plugin Obsidian

Per il plugin, il flusso standard è quello dei community plugin Obsidian:

- artifact richiesti: `main.js`, `manifest.json`, `styles.css` opzionale;
- `manifest.json` deve restare coerente con la release;
- `versions.json` deve mappare la versione del plugin alla `minAppVersion`.

Nel repo:

- `package.json` usa `esbuild` e `tsc`;
- `esbuild.config.mjs` bundle-a `src/main.ts` in `main.js`;
- `manifest.json` dichiara `id: yaos`, `version: 1.5.1`, `isDesktopOnly: false`.

## Server Cloudflare

Il deploy raccomandato è tramite il pulsante Cloudflare Deploy puntato alla sottodirectory `server/` (`README.md`, `server/README.md`).

Il deploy base è volutamente text-only:

- Worker + Durable Objects subito disponibili;
- nessun bucket R2 obbligatorio;
- nessun `SYNC_TOKEN` obbligatorio inizialmente;
- il server parte in stato unclaimed e si reclama dal browser.

Configurazione infrastrutturale corrente (`server/wrangler.toml`):

- Worker `main = "src/index.ts"`
- Durable Object `YAOS_SYNC`
- Durable Object `YAOS_CONFIG`
- migration `v1` con classi SQLite-backed
- observability logs abilitati

## Claim e pairing

Dopo il deploy server:

1. si apre l'URL del Worker;
2. si clicca Claim;
3. il browser genera il token;
4. il server salva solo l'hash del token;
5. viene generato un deep link `obsidian://yaos?...` oppure una pagina mobile/QR;
6. il plugin si configura automaticamente.

Questo comportamento è descritto in `engineering/zero-config-auth.md`.

## Update del server

YAOS non considera sicuro ri-cliccare Deploy per aggiornare un server stateful. La strategia corretta è Git-based (`README.md`, `engineering/zero-ops-update-pipeline.md`):

1. deploy iniziale tramite Cloudflare Deploy;
2. bootstrap una volta del workflow `.github/workflows/yaos-ops.yml` nel repo generato;
3. l'utente lancia il workflow con `update` o `revert`;
4. il workflow applica un artifact server (`yaos-server.zip`) e Cloudflare rideploya.

Nel repo root esiste `build-server-release.mjs`, che costruisce:

- `dist/release-assets/update-manifest.json`
- `dist/release-assets/yaos-server.zip`

## Possibilità di personalizzazione

## Settings plugin

Le principali superfici configurabili sono in `src/settings.ts`:

- `host`
- `token`
- `vaultId`
- `deviceName`
- `debug`
- `excludePatterns`
- `maxFileSizeKB`
- `externalEditPolicy`
- `enableAttachmentSync`
- `maxAttachmentSizeKB`
- `attachmentConcurrency`
- `showRemoteCursors`
- `updateRepoUrl`
- `updateRepoBranch`

Default notevoli:

- `maxFileSizeKB = 2048`
- `enableAttachmentSync = true`
- `maxAttachmentSizeKB = 10240`
- `attachmentConcurrency = 1`
- `showRemoteCursors = true`
- `externalEditPolicy = "always"`

## Politiche modifiche esterne

`externalEditPolicy` controlla come gestire file cambiati da git, script o altri editor:

- `always`
- `closed-only`
- `never`

È una personalizzazione importante per chi usa workflow automatici o agenti AI che scrivono nel vault.

## Exclude patterns

Il plugin supporta path prefix esclusi via setting; in più esclude sempre:

- cartella config di Obsidian
- `.trash/`

Implementazione: `src/sync/exclude.ts`, `src/types.ts`.

## Capabilities opzionali

Se il server ha R2 (`YAOS_BUCKET`):

- attachment sync disponibile;
- snapshots disponibili.

Se non ha R2:

- il sync testo continua a funzionare;
- UI snapshot/allegati viene disabilitata o degradata correttamente.

Questa è una scelta di prodotto esplicita per evitare di imporre il requisito di carta di credito Cloudflare al primo deploy.

## Comandi disponibili nel plugin

Dal command palette il progetto espone comandi per:

- reconnect;
- force reconcile;
- debug info;
- export diagnostics;
- import untracked files;
- reset local cache;
- snapshot now;
- browse/restore snapshots;
- nuclear reset.

## Scelte architetturali principali

## Scelta 1: monolite CRDT per vault

Pro:

- atomicità cross-file;
- rename cartelle consistenti;
- snapshot facili;
- modello mentale semplice;
- comportamento collaborativo molto forte.

Contro:

- ceiling pratico su vault molto grandi;
- cold start/replay più costosi;
- costo CPU/memoria maggiore su mobile.

Riferimento: `engineering/monolith.md`.

## Scelta 2: correttezza prima del throughput

Il progetto sceglie spesso serializzazione e safety invece di parallelismo aggressivo:

- `saveChain` lato server;
- lock per path lato disco;
- blob concurrency bassa;
- queue attachment conservative;
- fail-closed su mismatch storage;
- tombstone retention per evitare resurrection.

Riferimenti: `engineering/checkpoint-journal.md`, `engineering/filesystem-bridge.md`, `engineering/attachment-sync.md`, `engineering/warts-and-limits.md`.

## Scelta 3: zero-terminal onboarding

La UX di claim via browser + deep link `obsidian://` è una scelta esplicita di prodotto. Il repo evita setup CLI e `.env` obbligatori per l'utente finale.

Riferimento: `engineering/zero-config-auth.md`.

## Limiti dichiarati

I limiti dichiarati in README e docs:

- vault grandi di puro testo non sono il target ideale;
- soglia confortevole: circa 40-50 MB di raw text;
- mobile soffre prima di desktop;
- il progetto non vuole essere un sync engine infinito per archivi enormi;
- auth WebSocket via query token è una compromise documentata, non stato finale;
- non esiste ancora un design shard-per-file in produzione;
- tombstone e storia CRDT crescono nel tempo.

Riferimenti: `README.md`, `engineering/monolith.md`, `engineering/warts-and-limits.md`.

## Possibili direzioni future implicite o esplicite

- handshake auth WebSocket post-connect al posto del query token;
- eventuale sharding per-file del CRDT solo se il profiler lo giustifica;
- possibile miglioramento throughput attachment sync;
- futura evoluzione dei metadata sidecar per admission/health;
- refactor di file molto grandi come `src/main.ts` e `src/sync/vaultSync.ts`.

## Considerazioni operative

## Packaging/release plugin

Verifiche esterne confermano che per Obsidian servono:

- tag release uguale alla versione manifest;
- `main.js`, `manifest.json` e `styles.css` come asset release;
- `id` plugin stabile nel tempo.

## Deploy/update Cloudflare

Verifiche esterne confermano che:

- il Deploy button supporta repo/subdirectory isolate;
- Durable Object migrations sono un punto sensibile e vanno trattate con attenzione;
- R2 e DO richiedono binding espliciti;
- per sistemi stateful il flusso update separato dal primo deploy è una scelta sensata.

## Conclusione

YAOS è un progetto abbastanza sofisticato: non è un semplice file sync, ma un sistema local-first, CRDT-based, con server stateful, deploy consumer-friendly e forte attenzione alla safety dei dati.

In pratica:

- per note Markdown normali è un'architettura molto forte;
- per allegati usa un canale separato pragmatico;
- per deploy minimizza gli attriti iniziali;
- per update preferisce un flusso sicuro e ripetibile;
- per correctness sacrifica deliberatamente una parte di throughput e scalabilità estrema.

Se si vuole implementare cambiamenti su questo progetto, i punti più sensibili sono:

- `src/main.ts`
- `src/sync/vaultSync.ts`
- `src/sync/diskMirror.ts`
- `src/sync/blobSync.ts`
- `server/src/index.ts`
- `server/src/server.ts`
- `server/src/chunkedDocStore.ts`

perché lì vive il cuore delle garanzie di correttezza.
