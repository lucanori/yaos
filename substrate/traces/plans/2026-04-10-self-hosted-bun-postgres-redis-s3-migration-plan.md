# Piano di migrazione completo verso Bun + PostgreSQL + Redis opzionale + S3

Data: 2026-04-10

## Obiettivo

Migrare YAOS da:

- Cloudflare Workers
- Durable Objects
- R2
- wrangler
- npm/node-centric workflow

verso:

- server self-hosted in container Docker
- runtime Bun
- PostgreSQL come store persistente primario
- Redis opzionale per cache/coordination
- bucket S3-compatible generico per blob e snapshot
- reverse proxy standard davanti al servizio

## Executive summary

La migrazione è fattibile senza riscrivere il plugin Obsidian, ma richiede una **riscrittura sostanziale del runtime server**.

Le parti da preservare il più possibile sono:

- protocollo e contratti HTTP/WebSocket verso il plugin
- modello CRDT del vault
- engine checkpoint+journal
- chiavi oggetti blob/snapshot
- flow di auth/claim/capabilities

La strategia raccomandata è:

1. introdurre seam e adapter;
2. costruire un nuovo backend self-hosted affiancato a quello Cloudflare;
3. validarlo via test e compatibilità client;
4. gestire la migrazione dati;
5. fare cutover;
6. deprecare il path Cloudflare.

## Stato attuale da rispettare

## Client plugin da preservare

Il plugin usa:

- WebSocket su `/vault/sync/:vaultId`
- query params `token` e `schemaVersion`
- HTTP API per capabilities, blob e snapshot
- frame `__YPS:` per fatal auth/control messages

Riferimenti:

- `src/sync/vaultSync.ts`
- `src/sync/serverCapabilities.ts`
- `src/sync/blobSync.ts`
- `src/sync/snapshotClient.ts`

## Server-side seam più importante

`server/src/chunkedDocStore.ts` contiene già un’astrazione `StorageLike` / `TransactionLike`. Questo è il punto da salvare assolutamente e da portare sopra PostgreSQL.

Riferimento:

- `server/src/chunkedDocStore.ts:36-49`

## Vincoli architetturali da mantenere

- un vault continua a essere un singolo `Y.Doc`
- salvataggi ordinati e serializzati
- snapshot daily-idempotent
- trace fail-open
- schema/capabilities compatibili col plugin
- auth semantics identiche o strettamente equivalenti

## Architettura target raccomandata

## Server runtime

- **Bun** come runtime del server self-hosted
- HTTP + WebSocket server nello stesso processo
- room manager in memoria: `Map<vaultId, VaultRoom>`
- caricamento lazy delle room
- eviction solo per room inattive e senza client connessi

## Persistenza primaria

- **PostgreSQL** come store transazionale per:
  - checkpoint/journal
  - room metadata
  - trace bounded
  - config server
  - eventuale metadata snapshot

## Object storage

- **S3-compatible bucket** per:
  - blob attachment
  - snapshot payload

## Redis

Redis **non è richiesto nella prima iterazione** per correttezza.

Usi ammessi solo se servono davvero:

- pub/sub cross-instance in futuro
- cache room metadata/capabilities
- rate limiting
- distributed coordination in un domani multi-instance

Per la prima distribuzione target, Redis va trattato come **opzionale**, non core dependency.

## Docker deployment

Stack minimo consigliato:

- `yaos-server` (Bun)
- `postgres`
- `redis` opzionale
- nessun MinIO obbligatorio in produzione, ma utile per test locali
- reverse proxy esterno o nello stesso compose secondo preferenza

## Contratti da mantenere invariati

Questi contratti devono restare stabili per non rompere il plugin:

1. `GET /api/capabilities`
2. `POST /claim`
3. `POST /vault/:vaultId/blobs/exists`
4. `PUT /vault/:vaultId/blobs/:hash`
5. `GET /vault/:vaultId/blobs/:hash`
6. `POST /vault/:vaultId/snapshots/maybe`
7. `POST /vault/:vaultId/snapshots`
8. `GET /vault/:vaultId/snapshots`
9. `GET /vault/:vaultId/snapshots/:snapshotId`
10. WebSocket `/vault/sync/:vaultId`
11. frame `__YPS:<json>` per errori fatal auth

## Decisioni architetturali consigliate

## Decisione 1: usare PostgreSQL come KV transazionale logico

Invece di forzare un redesign completo del persistence layer, implementare un adapter che mappi il modello `StorageLike` su tabelle Postgres.

Motivo:

- preserva `ChunkedDocStore`
- preserva logica checkpoint+journal
- riduce rischio di regressione

### Schema iniziale raccomandato

Tabella key-value per vault:

- `vault_id`
- `key`
- `value BYTEA/JSONB a seconda del payload`

Tabella config globale:

- `key`
- `value`

Tabella trace dedicata oppure namespace nello stesso KV, in base alla semplicità dell’adapter.

## Decisione 2: non introdurre Redis nella fase 1 server core

Motivo:

- non aggiunge valore alla correttezza iniziale
- aumenta il perimetro di failure
- YAOS è BYOC/small-scale per sua natura

Redis va introdotto solo dopo che il server Bun + Postgres è stabile.

## Decisione 3: Bun come runtime, non come motivo per riscrivere il plugin build subito

Per il plugin conviene inizialmente:

- lasciare `esbuild` dov’è
- usare Bun come package manager/runtime per script e test
- valutare solo dopo l’eventuale sostituzione del bundler plugin

Motivo:

- il rischio vero è il server migration, non il plugin bundling
- minimizzare superfici di cambiamento simultanee

## Decisione 4: il server nuovo deve vivere parallelo a quello vecchio durante la migrazione

Niente big bang.

Serve una fase di parallel run con export/import controllato.

## Moduli target da introdurre

## Nuovi layer consigliati

### `server/src/contracts/`

Per interfacce condivise del backend:

- `storage.ts`
- `blob-store.ts`
- `trace-store.ts`
- `room-meta-store.ts`

### `server/src/adapters/`

- `postgres-storage.ts`
- `postgres-config.ts`
- `s3-blob-store.ts`
- `redis-cache.ts` opzionale

### `server/src/runtime/`

- `bun-server.ts`
- `router.ts`
- `websocket.ts`
- `room-manager.ts`
- `vault-room.ts`

### `server/src/services/`

- `auth-service.ts`
- `capabilities-service.ts`
- `snapshot-service.ts`
- `blob-service.ts`
- `migration-service.ts` o script separati

## Moduli esistenti da preservare/adattare

- `server/src/chunkedDocStore.ts` → preservare e adattare
- `server/src/snapshot.ts` → preservare logica, sostituire bucket adapter
- `server/src/traceStore.ts` → preservare logica, cambiare backend
- `server/src/roomMeta.ts` → preservare logica
- `server/src/concurrency.ts` → preservare
- `server/src/asyncConcurrency.ts` → preservare
- `server/src/version.ts` → preservare

## Moduli da riscrivere

- `server/src/index.ts`
- `server/src/server.ts`
- parte di `server/src/config.ts`
- tooling deploy/update Cloudflare-specifico

## Piano per fasi

## Fase 0 — preparazione e congelamento dei contratti

### Obiettivo

Stabilire i contratti da non rompere prima di toccare il runtime.

### Attività

1. estrarre le interfacce storage e blob store in file dedicati;
2. documentare formalmente shape di:
   - capabilities
   - auth error payload
   - blob endpoints
   - snapshot endpoints
3. aggiungere test di contratto lato integrazione;
4. congelare il comportamento `__YPS:` lato plugin e server.

### Deliverable

- interfacce backend esplicite
- test contract-first
- documento con wire contract

### Exit criteria

- nessun cambiamento runtime
- test attuali verdi

## Fase 1 — migrazione toolchain a Bun senza cambiare ancora il server runtime di produzione

### Obiettivo

Passare il repository a Bun gradualmente, senza combinare subito toolchain change e backend rewrite.

### Attività

1. introdurre `bun.lock`;
2. migrare script root e server a `bun run` dove sensato;
3. eliminare progressivamente `jiti` dai test, usando supporto TS nativo di Bun;
4. tenere temporaneamente i test wrangler dove necessario;
5. aggiornare la documentazione di sviluppo.

### Note

- `esbuild` può restare per il plugin in questa fase;
- wrangler-specific tests possono restare separati finché il backend Cloudflare esiste.

### Exit criteria

- progetto installabile con Bun
- build plugin funzionante
- test locali principali eseguibili via Bun o wrapper Bun

## Fase 2 — adapter PostgreSQL per `ChunkedDocStore`

### Obiettivo

Portare il motore di persistenza esistente sopra PostgreSQL prima di cambiare il protocollo server.

### Attività

1. implementare `PostgresStorageAdapter`;
2. mappare `transaction()` a vere transazioni SQL;
3. portare `ServerConfig` a Postgres;
4. portare `roomMeta` e trace store su Postgres;
5. eseguire `tests/chunked-doc-store.ts` e `tests/trace-store.ts` contro Postgres.

### Exit criteria

- checkpoint+journal validato su Postgres
- claim flow equivalente
- trace bounded e fail-open preservato

## Fase 3 — adapter S3-compatible

### Obiettivo

Sostituire R2 con backend S3-compatible mantenendo le stesse chiavi logiche.

### Attività

1. introdurre `S3BlobStoreAdapter`;
2. portare blob exists/upload/download;
3. portare snapshot create/list/get;
4. validare metadata content-type e pagination;
5. test contro MinIO locale + almeno un provider reale S3-compatible.

### Exit criteria

- blob roundtrip funzionante
- snapshot roundtrip funzionante
- key schema invariato

## Fase 4 — nuovo runtime server Bun

### Obiettivo

Rimpiazzare Durable Objects e Worker runtime con room manager in processo e server Bun.

### Attività

1. implementare `RoomManager`;
2. implementare `VaultRoom` con:
   - `ydoc`
   - `saveChain`
   - `snapshotMaybeChain`
   - `loadPromise`
   - gestione client connessi
3. implementare server HTTP;
4. implementare server WebSocket;
5. replicare handshake, schema admission, auth checks;
6. replicare invio di fatal auth control frames `__YPS:`;
7. preservare onload/save semantics.

### Decisione critica da risolvere all’inizio della fase

Scegliere se:

- usare `y-websocket` come base server;
- usare Hocuspocus;
- implementare il protocollo custom sopra `ws`/Bun WebSocket.

### Raccomandazione

Valutare `y-websocket` come base di protocollo e mantenere custom persistence/lifecycle YAOS attorno a esso.

### Exit criteria

- plugin esistente si connette senza cambiamenti
- sync, awareness e auth funzionano
- test integrazione passano contro il nuovo server

## Fase 5 — setup, claim, capabilities e UX self-hosted

### Obiettivo

Rimpiazzare la narrativa Cloudflare con UX self-hosted generica.

### Attività

1. adattare setup page per server Docker/self-hosted;
2. mantenere claim flow browser-based se utile;
3. aggiornare capability flags per S3 configurato/non configurato;
4. rimuovere o deprecare update flow Cloudflare-specifico;
5. aggiornare testi plugin che parlano di Cloudflare/R2.

### Exit criteria

- onboarding self-hosted coerente
- capabilities corrette
- niente copy Cloudflare obbligatoria nel flusso primario

## Fase 6 — migrazione dati

### Obiettivo

Portare vault esistenti dal backend Cloudflare al nuovo backend.

### Strategia raccomandata

1. forzare snapshot dal server Cloudflare;
2. esportare snapshot CRDT;
3. copiare blob/snapshot objects da R2 a nuovo bucket S3;
4. importare snapshot come checkpoint iniziale nel backend nuovo;
5. migrare config e token hash dove possibile;
6. preparare fallback re-claim se token hash non è recuperabile.

### Rischio principale

Il recupero di `tokenHash` dal vecchio backend può essere il punto più delicato.

### Exit criteria

- import di un vault reale riuscito
- verifica consistenza CRDT post-import
- verifica blob referenced vs oggetti presenti

## Fase 7 — cutover controllato

### Obiettivo

Passare produzione al nuovo server senza big bang.

### Attività

1. deploy server nuovo;
2. parallel run limitato;
3. aggiornamento `host` nei client;
4. monitoraggio sync/auth/blob/snapshot;
5. rollback plan pronto;
6. decommission Cloudflare solo dopo stabilizzazione.

### Exit criteria

- nessuna regressione critica in finestra di osservazione
- rollback non necessario

## Test strategy

## Test che devono esistere prima del cutover

### Unit / adapter

- `ChunkedDocStore` su Postgres
- trace store su Postgres
- config atomic claim su Postgres
- S3 adapter su blob e snapshot

### Integration

- websocket sync plugin-compatible
- fatal auth frame `__YPS:`
- capabilities contract
- snapshot maybe idempotent
- blob exists/upload/download
- schema version guard

### Migration tests

- export da vecchio backend e import nel nuovo
- verifica byte-equivalent o merge-equivalent del CRDT
- verifica presenza blob hash referenziati

### E2E

- vault desktop
- vault mobile almeno smoke path
- attachment sync
- snapshot restore selettivo

## Rischi principali

## Rischio 1 — protocollo websocket incompatibile col client attuale

Mitigazione:

- test di compatibilità wire-level
- preservare path, params, control frames e semantica sync

## Rischio 2 — regressioni del persistence layer

Mitigazione:

- preservare `ChunkedDocStore`
- validarlo prima del runtime swap

## Rischio 3 — token/config migration incompleta

Mitigazione:

- preparare export path o fallback re-claim documentato

## Rischio 4 — troppo scope contemporaneo

Mitigazione:

- separare Bun migration, Postgres migration e runtime rewrite in fasi
- non migrare tutto in un singolo PR

## Rischio 5 — Redis introdotto troppo presto

Mitigazione:

- tenerlo fuori dal critical path della fase 1-4

## Decisioni di prodotto da prendere esplicitamente

1. il nuovo server deve supportare ancora il claim flow browser-based?
2. il plugin deve rimuovere del tutto la copy Cloudflare o solo deprecarla?
3. l’update flow plugin resta come metadata generico o viene ridisegnato?
4. Redis è opzionale in produzione o supportato ufficialmente come parte dello stack?
5. il nuovo backend deve supportare singola istanza soltanto nella v1 self-hosted o già multi-instance?

## Ordine consigliato dei PR / milestone

### Milestone 1

- seam extraction
- Bun package manager/runtime baseline

### Milestone 2

- Postgres adapters
- test verdi su persistence

### Milestone 3

- S3 adapter
- blob/snapshot compatibili

### Milestone 4

- nuovo server Bun + room manager
- protocol compatibility pass

### Milestone 5

- setup UX self-hosted
- docs e Docker packaging

### Milestone 6

- migration tooling
- real vault migration dry run

### Milestone 7

- production cutover
- deprecation Cloudflare path

## File da toccare prioritariamente

### Priorità massima

- `server/src/chunkedDocStore.ts`
- `server/src/server.ts`
- `server/src/index.ts`
- `server/src/config.ts`
- `server/src/snapshot.ts`
- `server/src/traceStore.ts`
- `tests/chunked-doc-store.ts`
- `tests/worker-integration.mjs`

### Priorità media

- `server/package.json`
- `package.json`
- `server/README.md`
- `README.md`
- `src/settings.ts`
- `src/main.ts`

### Nuovi file/directory principali

- `server/src/contracts/*`
- `server/src/adapters/*`
- `server/src/runtime/*`
- `server/src/services/*`
- `server/Dockerfile`
- `server/docker-compose.yml`

## Piano di rollback

Finché il cutover finale non è completato:

- il backend Cloudflare deve restare preservato;
- i client devono poter tornare al vecchio `host`;
- la migrazione deve essere snapshot-driven, non destructive;
- nessuna cancellazione di stato vecchio prima della validazione del nuovo.

## Stima qualitativa

### Complessità

Alta ma controllabile.

### Sequenziamento corretto

Fondamentale.

### Durata realistica

- MVP tecnico serio: 2-3 settimane focalizzate
- migrazione completa con tooling, docs e rollout robusto: 4-6 settimane

## Conclusione

La migrazione corretta non è “portare il Worker dentro Docker”, ma:

- estrarre il core sync server da Cloudflare;
- re-hostarlo su Bun;
- preservare i contratti verso il plugin;
- appoggiarlo su Postgres e S3;
- usare Redis solo dove porta valore misurabile.

La priorità assoluta è mantenere intatte le garanzie di correttezza di YAOS, non inseguire ottimizzazioni premature.

## Nota finale

Questo documento è un piano. Non avvia l’implementazione.

Per iniziare l’implementazione vera e propria serve passare all’agente **orchestrator**.
