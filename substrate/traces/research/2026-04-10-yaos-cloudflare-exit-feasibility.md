# Fattibilità di uscita da Cloudflare

Data: 2026-04-10

## Domanda

Valutare quanto sia fattibile staccare YAOS completamente da Cloudflare e portarlo verso:

- server Docker self-hosted;
- esposizione dietro reverse proxy;
- storage oggetti su bucket S3-compatible generico;
- mantenendo il plugin Obsidian e il modello funzionale generale.

## Risposta breve

Sì, è fattibile.

Non è però un refactor “agile” nel senso di piccolo o rapido. È un refactor **medio-pesante ma ben delimitato**, perché il client Obsidian è già quasi del tutto portabile, mentre il server è oggi fortemente accoppiato a:

- Cloudflare Workers
- Durable Objects
- R2
- `partyserver` / `y-partyserver` lato server

In pratica:

- **plugin client**: quasi invariato;
- **server runtime**: da riscrivere in modo sostanziale;
- **storage engine checkpoint+journal**: riutilizzabile;
- **blob/snapshot layer**: adattabile a S3;
- **deploy/update UX**: da ridisegnare.

## Conclusione operativa

### Fattibilità tecnica

Alta.

### Complessità

Media-alta.

### Stima qualitativa

Per un risultato pulito e production-grade: circa **2-6 settimane** di lavoro focalizzato, a seconda di:

- quanta compatibilità si vuole conservare con l'architettura attuale;
- se si costruisce un server Node custom o si adotta una base come Hocuspocus/y-websocket;
- quanto si vuole supportare migrazione dati e UX di update.

## Cosa si può conservare

## 1. Plugin Obsidian quasi tutto

Il plugin non dipende realmente da Cloudflare: parla con un host configurabile via WebSocket e HTTP.

Riferimenti:

- `src/sync/vaultSync.ts`
- `src/sync/blobSync.ts`
- `src/sync/serverCapabilities.ts`
- `src/main.ts`

Il client usa:

- `y-partyserver/provider` lato client;
- endpoint HTTP normali;
- URL host configurabile dall’utente.

Quindi, se il nuovo server espone gli stessi path e un protocollo compatibile, la parte plugin richiede modifiche minime o nulle.

## 2. Modello CRDT e schema dati

Resta valido il modello con un singolo `Y.Doc` monolitico per vault.

Riferimenti:

- `src/sync/vaultSync.ts`
- `engineering/monolith.md`

## 3. Checkpoint + journal engine

Questa è la parte più importante riusabile.

`server/src/chunkedDocStore.ts` non è hardcoded su Cloudflare: dipende da un’interfaccia `StorageLike` / `TransactionLike` che può essere reimplementata sopra SQLite o altro backend KV transazionale.

Riferimenti:

- `server/src/chunkedDocStore.ts:36-49`
- `engineering/checkpoint-journal.md`

Questo vuol dire che il cuore della persistenza server non va buttato.

## 4. Formato snapshot e chiavi blob

Le chiavi object storage sono già abbastanza generiche:

- `v1/{vaultId}/blobs/{hash}`
- `v1/{vaultId}/snapshots/{day}/{snapshotId}/...`

Riferimento:

- `server/src/snapshot.ts`

Quindi il passaggio da R2 a S3-compatible è concettualmente semplice.

## Cosa è davvero Cloudflare-specifico

## 1. Durable Objects

È il coupling principale.

Riferimenti:

- `server/src/server.ts`
- `server/src/index.ts`
- `server/src/config.ts`
- `server/wrangler.toml`

Oggi YAOS usa due namespace DO:

- `YAOS_SYNC` per una room per vault;
- `YAOS_CONFIG` per config globale del server.

Questo significa che Cloudflare oggi fornisce insieme:

- routing per vault;
- storage locale transazionale per room;
- modello single-threaded per room;
- lifecycle/hydration della room.

Questa parte non è portabile 1:1 in Node senza riscrittura.

## 2. `partyserver` / `y-partyserver` lato server

Il server estende `YServer` da `y-partyserver`, che è basato su Durable Objects.

Riferimenti:

- `server/src/server.ts:48`
- `server/src/index.ts:1`

Questa è una dipendenza strutturale da sostituire.

## 3. R2 API

`head/get/put/list` su `R2Bucket` sono API Cloudflare-specifiche.

Riferimenti:

- `server/src/snapshot.ts`
- `server/src/index.ts`

Servirà un adapter su SDK S3.

## 4. Worker runtime model

L’entrypoint `fetch(req, env)` e `WebSocketPair` sono Worker-specific.

Riferimento:

- `server/src/index.ts`

## 5. Update pipeline

L’update flow è progettato attorno a Deploy-to-Cloudflare + GitHub Actions + repo generato.

Riferimenti:

- `engineering/zero-ops-update-pipeline.md`
- `src/main.ts`
- `src/settings.ts`

In un mondo Docker questa parte diventa obsoleta o va riscritta completamente.

## Quanto è fattibile davvero

## Sì, ma è un refactor server completo

Il punto chiave è questo:

- **non** stai cambiando il prodotto;
- **non** stai cambiando il protocollo Yjs a livello concettuale;
- **stai cambiando quasi tutto il runtime server**.

Quindi non è un rewrite totale dell’intero progetto, ma è un **rewrite importante della metà server**.

## Cosa va riscritto

### Area 1: room manager al posto dei DO

Serve un sostituto di `VaultSyncServer` che gestisca:

- una room per vault;
- stato CRDT in memoria;
- persistenza checkpoint+journal;
- websocket clients connessi;
- serializzazione save/snapshot.

In Node questo può essere:

- una `Map<vaultId, VaultRoom>` in processo;
- con evizione room inattive dopo TTL;
- storage su SQLite.

### Area 2: websocket sync server

Devi sostituire `y-partyserver` server-side con:

- server custom su `ws`, oppure
- base su `@y/websocket-server`, oppure
- base su Hocuspocus.

### Area 3: adapter storage

Va implementato `StorageLike` sopra:

- SQLite locale, idealmente `better-sqlite3`, oppure
- PostgreSQL, meno naturale ma possibile.

La soluzione più coerente col design attuale è **SQLite**.

### Area 4: adapter S3

Va costruito un layer compatibile con le operazioni oggi fatte su R2:

- `put`
- `get`
- `head`
- `list`

usando un generico provider S3-compatible.

### Area 5: config/auth store

`ServerConfig` va portato da DO a DB locale.

### Area 6: setup/update UX

Il setup page e l’update path oggi raccontano Cloudflare. In Docker andrebbero semplificati verso:

- env vars o config file;
- claim opzionale oppure token statico;
- documentazione deploy/restart classica;
- niente workflow GitHub-ops Cloudflare-specifico.

## Quanto è “agile” questo refactor?

## Non molto agile come singolo salto

Se per “agile” intendi:

- poche modifiche;
- basso rischio;
- una settimana scarsa;
- retrocompatibilità quasi gratuita;

allora no.

## Abbastanza fattibile se fatto per fasi

Se invece lo tratti come una migrazione per seam architetturali, sì.

La base del progetto aiuta perché esistono già buone linee di separazione:

- `ChunkedDocStore` con interfaccia propria;
- route HTTP abbastanza portabili;
- schema snapshot portabile;
- client quasi indipendente dal runtime server.

## Strategia consigliata

## Opzione migliore: Node monolith + SQLite + S3 adapter

Architettura consigliata:

- server Node/TypeScript in container Docker;
- reverse proxy davanti;
- room manager in memoria;
- SQLite per config + persistenza room;
- S3 SDK per blob/snapshot;
- una cartella volume persistente per DB locali;
- optional healthcheck, metrics e backup.

Questa è la migrazione più naturale perché replica bene il modello BYOC single-user/small-team di YAOS senza introdurre subito cluster o architetture distribuite.

## Opzioni alternative

### Hocuspocus

Pro:

- server Yjs maturo su Node;
- auth hooks;
- ecosistema più self-host-friendly.

Contro:

- richiede adattamento più forte del modello persistence YAOS;
- rischia di spostare troppo l’architettura dal design attuale.

### y-websocket standard

Pro:

- più minimale;
- più vicino al protocollo puro.

Contro:

- più lavoro custom lato persistenza/lifecycle.

## Rischi principali

## 1. Protocollo websocket e compatibilità client

Il rischio più delicato è mantenere comportamento compatibile con il client plugin attuale, soprattutto per:

- fatal auth handling;
- sync lifecycle;
- awareness;
- reconnect behavior.

## 2. Regressioni di correttezza

La parte sensibile di YAOS non è “far sincronizzare qualcosa”, ma preservare:

- ordine;
- consistenza;
- restore;
- snapshot;
- bridge filesystem.

Se il nuovo server sbaglia il lifecycle room/save/load, il sistema degrada molto rapidamente.

## 3. Migrazione dati

Passare da DO state a Docker non è plug-and-play.

La via più realistica per migrare installazioni esistenti è:

- snapshot dal server Cloudflare;
- import nel nuovo backend.

## 4. Perdita della UX zero-ops Cloudflare

Con Docker perdi:

- deploy button instantaneo;
- update GitHub Action preintegrato;
- parte della narrativa “no terminal”.

Guadagni però:

- pieno controllo infrastrutturale;
- vendor neutrality;
- bucket S3 libero;
- reverse proxy standard;
- portabilità su qualsiasi server.

## Giudizio finale

## Fattibile?

Sì, decisamente.

## Si riesce “agilmente”?

Non nel senso di refactor piccolo.

## Si riesce in modo pragmatico e pulito?

Sì, se:

- si limita il refactor al server;
- si preserva il plugin quasi invariato;
- si riusa `ChunkedDocStore`;
- si adotta Node + SQLite + S3 come stack target;
- si tratta il passaggio come una nuova backend distribution, non come un patchino.

## Raccomandazione pratica

Io non lo imposterei come “rifacciamo tutto per staccarci da Cloudflare”.

Lo imposterei così:

1. estrarre un backend abstraction layer minimo;
2. implementare backend self-hosted Node/SQLite/S3;
3. mantenere compatibilità client;
4. poi rendere Cloudflare una delle possibili distribuzioni, non l’unica.

In altre parole: la mossa giusta non è un refactor distruttivo, ma una **separazione del runtime server dal core sync engine**.

## Prossimo passo consigliato

Se vuoi procedere davvero, il deliverable corretto adesso non è codice ma un **implementation plan** con:

- target architecture;
- seams da introdurre;
- ordine esatto delle fasi;
- strategia di compatibilità client;
- piano migrazione dati;
- test plan regressivo.

Per iniziare l’implementazione vera e propria dovresti passare all’agente **orchestrator**.
