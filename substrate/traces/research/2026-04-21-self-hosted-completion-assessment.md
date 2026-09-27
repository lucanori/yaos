# Valutazione stato migrazione self-hosted Docker

Data: 2026-04-21

## Domanda

Valutare se il lavoro svolto nelle operazioni precedenti abbia completato la transizione di YAOS verso un progetto realmente self-hosted, con deployment Docker, mantenendo sync realtime per vault Obsidian.

## Contesto trovato

- Nessun file `substrate/directives/DRC-*.md` presente.
- Nessun file `substrate/expectations/EXP-*.md` presente.
- Tracce rilevanti:
  - `substrate/traces/operations/2026-04-10-self-hosted-migration-implementation.md`
  - `substrate/traces/operations/2026-04-10-bun-only-toolchain-migration.md`
  - `substrate/traces/plans/2026-04-10-self-hosted-bun-postgres-s3-migration-plan.md`

## Verdetto

## Sintesi breve

**Quasi completato sul piano tecnico runtime/deploy. Non ancora completato al 100% sul piano prodotto/repository/cutover.**

Più precisamente:

- **self-hosted operativo**: sì;
- **stack Docker presente**: sì;
- **realtime sync Bun/Postgres/S3 presente**: sì;
- **dipendenza runtime da Cloudflare per path self-hosted**: no;
- **migrazione totale del progetto e narrativa intera repo verso self-hosted**: non ancora del tutto;
- **evidenza di cutover definitivo, migrazione dati reale e cleanup finale**: assente.

## Evidenze forti di completamento

### Runtime self-hosted attivo

- `server/src/main.ts:23-29` istanzia `YaosServer` con `port`, `databaseUrl`, `syncToken`, `canonicalRepo`, config S3.
- `server/src/bun.ts:251-260` definisce il server Bun come runtime principale.
- `server/src/room.ts:52-80` implementa room realtime basata su `Y.Doc`, `PostgresStorage`, `YPartyServer` compatibile.
- `server/src/roomManager.ts:18-79` gestisce lifecycle room in memoria con creazione lazy.

### Persistenza self-hosted

- `server/src/storage/postgres.ts:23-54` crea tabella `yaos_storage` in PostgreSQL.
- `server/src/storage/postgres.ts:126-140` espone transazioni per preservare il modello checkpoint+journal.
- `server/src/storage/s3.ts:44-176` implementa object storage S3-compatible per blob e snapshot.

### Compatibilità col plugin

- `src/sync/vaultSync.ts:222-238` continua a usare WebSocket `/vault/sync/<vaultId>` con `token` e `schemaVersion`.
- `src/sync/vaultSync.ts:272-279` continua a gestire frame `__YPS:` / custom fatal auth.
- `manifest.json:6` descrive il prodotto come basato su “your own sync server”.
- `src/settings.ts:10-17` configura host/token/vaultId in modo generico self-hosted, non Cloudflare-specifico.

### Docker e deployment

- `deployment/ops/Dockerfile:1-16` costruisce immagine Bun dedicata.
- `deployment/ops/compose.yaml:1-279` definisce stack con `yaos-app`, `postgres`, e storage S3-compatible esterno per blob/snapshot.
- `server/README.md:3-25` documenta il server come self-hosted Bun/PostgreSQL/S3.

### Tracce operative pregresse

- `substrate/traces/operations/2026-04-10-self-hosted-migration-implementation.md:1-2` marca la migrazione come `completed`.
- stesso file, `:92-111`, riporta validazioni Docker, HTTP, blob, snapshot e smoke sync reale.
- `substrate/traces/operations/2026-04-10-bun-only-toolchain-migration.md:39-43` indica anche toolchain/documentazione spostate verso Bun + self-hosted.

## Evidenze che impediscono il “100% completato”

### 1. Cloudflare non è davvero decommissionato nel repository

- `server/src/index.ts:1-39` contiene ancora entrypoint Worker con Durable Objects e R2.
- `server/wrangler.toml:1-18` è ancora presente.
- `server/package.json:32-37` mantiene `wrangler` tra le devDependency.
- `tests/worker-integration.mjs:7-18` e `:101-128` mantengono test integrazione via Wrangler.

Conclusione: **path self-hosted esiste ed è usabile, ma repo non è ancora “solo self-hosted”.**

### 2. Documentazione ancora mista o parzialmente obsoleta

- `README.md:107` parla ancora di attachment sync come “Native Worker proxy uploads”.
- `README.md:126` descrive ancora **Server URL** come “Your Worker URL”.
- `server/SELF_HOSTED.md:113-123` dice che “A Dockerfile can be created”, ma il Dockerfile esiste già in `deployment/ops/Dockerfile`.

Conclusione: **filosofia self-hosted presente, ma narrativa repository non ancora rifinita fino in fondo.**

### 3. Evidenza test incompleta per dire “production-ready finale”

- La traccia operativa dichiara smoke test forti, ma nel codice corrente `server/src/test/validate.ts:29-222` è soprattutto un validation script superficiale: importa moduli, verifica shape e invarianti base, non sostituisce un rehearsal completo.
- La stessa traccia operativa ammette limite esplicito: `substrate/traces/operations/2026-04-10-self-hosted-migration-implementation.md:84-89` dice che la validazione è stata fatta con smoke/endpoint checks, **non** con migrazione produzione su dati reali.

Conclusione: **funzionalità plausibilmente pronta per single-node self-hosted, ma non dimostrata come chiusura definitiva di migrazione completa.**

### 4. Fasi finali del piano non hanno prova di chiusura

Il piano originario prevedeva anche:

- migrazione dati reale;
- cutover;
- deprecation/decommission Cloudflare.

Le tracce lette non mostrano prova completa di queste fasi finali.

## Valutazione finale per area

| Area | Stato | Nota |
|---|---|---|
| Runtime self-hosted Bun | completato | implementato |
| PostgreSQL come store primario | completato | implementato |
| S3-compatible blob/snapshot | completato | implementato |
| Docker local stack | completato | implementato |
| Compatibilità plugin sync realtime | sostanzialmente completato | contratti principali preservati |
| Rimozione dipendenza runtime Cloudflare per self-host | completato | path Bun attivo |
| Cleanup repository da legacy Cloudflare | non completato | file/test/config legacy restano |
| Documentazione coerente 100% self-hosted | non completato | vari riferimenti Worker/Cloudflare restano |
| Migrazione dati/cutover definitivo | non provato | manca evidenza finale |

## Giudizio netto

Se domanda è:

> “YAOS oggi può funzionare come servizio self-hosted realtime per Obsidian con Docker, senza bisogno del runtime serverless originario?”

Risposta: **sì**.

Se domanda è:

> “Migrazione progetto verso filosofia 100% self-hosted completata in tutto e per tutto?”

Risposta: **non ancora al 100%**.

Stima sintetica:

- **85-90% completato** come migrazione tecnica self-hosted;
- **non completato** come chiusura totale del vecchio mondo Cloudflare/serverless.

## Cosa manca per poter dire “completato” senza asterischi

1. decidere se il path Cloudflare va eliminato o solo marcato legacy;
2. ripulire README e docs residue da copy Worker/Cloudflare/R2;
3. allineare `server/SELF_HOSTED.md` al Docker path reale già presente;
4. separare o rimuovere i test Wrangler se la direzione è solo self-hosted;
5. documentare esplicitamente eventuale migrazione dati/cutover da installazioni vecchie;
6. fare una validazione finale end-to-end su vault reale o rehearsal documentato.

## Conclusione pratica

**Lavoro buono e sostanzioso. Obiettivo core raggiunto. Claim “100% completato” troppo forte, oggi. Claim corretto: “self-hosted Bun/Postgres/S3 con Docker implementato e funzionante, restano cleanup finale, docs e decommission legacy”.**
