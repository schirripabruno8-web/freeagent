# FreeAgent

[English](README.md) | **Italiano**

App desktop per Windows (Electron + TypeScript) che usa le **chat web gratuite** (DeepSeek, Qwen, ...) come agenti: leggono e modificano file,
usano server MCP e skill, anche con sub-agenti su modelli diversi. Nessuna API a pagamento, nessuna chiave: fai il login a mano nella pagina della chat, dentro l'app.
Requisiti e installazione: vedi il [README in inglese](README.md#requirements) (scarica lo zip da Releases, oppure doppio clic su `Install.bat`).

> **Avviso.** Automatizzare l'interfaccia di una chat web puo' violare i termini d'uso del servizio. FreeAgent non ruota account, non aggira captcha o limiti, non falsifica il browser:
> a un limite si ferma o passa a un altro provider. Usalo con i tuoi account, a tuo rischio. Non e' affiliato a nessun provider.

## Comandi
```bash
npm test               # parser, loop, adapter, sandbox, permessi, tool, checkpoint, orchestratore, UI
npm run typecheck
npm run build          # out/main, out/preload, out/renderer
npx electron .         # avvia l'app (dopo build)
npm run pack           # crea release/win-unpacked/FreeAgent.exe (rifiuta di partire se l'app e' aperta)
npm run inspect -- deepseek   # apre la pagina nel browser integrato e salva la struttura DOM
```

## Eseguibile
Dalle Releases: zip, estrai, `FreeAgent.exe` (non e' firmato: SmartScreen chiede "Ulteriori informazioni" > "Esegui comunque"). Da sorgenti: `Install.bat` crea anche il collegamento sul Desktop; `FreeAgent.bat` avvia l'app.
Per generare l'exe tu stesso: `npm run pack` con FreeAgent **chiuso** (circa 1 minuto) -> `release/win-unpacked/FreeAgent.exe`. `config/` sta in `release/win-unpacked/resources/app/config`.
Il login ai provider e' condiviso tra exe, `npx electron .` e `npm run inspect` (profilo `%APPDATA%\freeagent`), ma non due insieme.
**Non copiare mai `%APPDATA%\freeagent` quando condividi l'app**: li' ci sono i tuoi login e la tua cronologia (l'app e lo zip delle Releases non li contengono).
Google non permette il login nel browser integrato: usa email e password del provider.

## Uso
La colonna di sinistra ha tre schede: **Task** (la conversazione in alto, il compositore in basso), **Recenti** (le chat passate) e **Strumenti** (MCP, skill, checkpoint).
Nel compositore: provider, modello (con ricerca e filtri nella sezione richiudibile), permessi (quattro pulsanti), cartella di lavoro (campo, cartella, **Recenti**), il testo e i pulsanti.
Mentre un task gira le opzioni si richiudono in una riga (**Modifica** le riapre). A destra la pagina del provider: il login si fa li' a mano; in alto a destra della colonna, lo stato e i messaggi di oggi.
Un provider e' "non pronto" finche' non esiste `config/selectors/<provider>.json` (vedi "Aggiungere un provider"). Ctrl+Invio invia.
**Avvia** apre sempre una chat NUOVA sul provider. **Continua** manda il testo del task come seguito nella chat che vedi a destra (correzioni, aggiunte: il modello ricorda il lavoro e i file fatti; il protocollo dei comandi viene ripetuto nel messaggio).
**Immagine...** allega fino a 4 immagini (png/jpg/webp/gif, 10 MB) al primo messaggio dell'agente principale: serve un provider con i selettori `attach` (come un utente: bottone "+", voce "carica", attesa della miniatura)
(i sub-agenti non le ricevono; una chat lunga che riparte non le ripete). Il main accetta solo i file scelti con quel pulsante.

## Vedere il risultato: render, look e la skill visual-check
Gli agenti non vedono lo schermo, ma possono controllare quello che hanno fatto, tutto in background (non si apre nessuna finestra):
- **`render`**: disegna un file come PNG in `<cartella di lavoro>/.freeagent/preview/`. `.pptx/.ppt/.odp`: le slide le disegna **PowerPoint stesso** (via COM, su una copia del file, senza finestra; se PowerPoint era gia' aperto da te non lo chiude).
  `.html/.htm/.svg`: una finestra nascosta di Electron, senza rete (solo file locali). Word/Excel/PDF: non ancora.
- **`look`**: mostra da 1 a 4 immagini a una chat con la vista (`vision` in `config/agents.json`, oggi Qwen, l'unica con i selettori `attach`) e restituisce il verdetto scritto. Funziona per tutti gli agenti, anche quelli su DeepSeek che non vedono.
  Ogni chiamata e' un messaggio sul tuo account: tetto di 10 per esecuzione di un agente (`vision.maxCalls`) e il revisore riporta solo difetti veri, non gusti.
- **Skill `visual-check`** (`skills/visual-check/SKILL.md`): il ciclo costruisci -> disegna -> guarda -> correggi (al massimo 3 giri), le liste di controllo per PowerPoint (python-pptx), pagine web e scene Blender (con la camera di controllo gia' scritta) e un controllo via codice per chi non puo' usare look.
  Il principale la vede da solo; un sub-agente la usa se la elenca in `skills`, e usa `render`/`look` se li elenca in `tools`. In `agents.json` ci sono `modeler` (Blender) e `builder` (file, PowerPoint, HTML) che hanno tutto.
Le anteprime restano in `.freeagent/preview/` (cartella di servizio: puoi cancellarla).

## Recenti (cronologia)
Ogni task finito si salva in `%APPDATA%\freeagent\history` (testo del compito, risposte, comandi, esito; mai cookie o password; al massimo 100 chat, 3000 eventi l'una).
In **Recenti**, raggruppate per giorno, con ricerca: un clic riapre la conversazione, porta il provider/cartella/modello di quella chat e mostra a destra **la pagina della chat sul sito**.
Da li' **Continua** prosegue nella stessa chat e la nuova richiesta si aggiunge alla stessa voce (la chat e' riconosciuta dall'indirizzo). Il cestino toglie la voce dalla cronologia (non la chat sul sito).
Non si apre una chat mentre un task gira.

## Permessi
- **Sola lettura**: legge, non scrive e non esegue comandi.
- **Chiedi prima** (default): ogni modifica di file e ogni comando shell chiedono il tuo ok, con il diff o il comando.
- **Auto nella cartella**: le modifiche dentro la cartella di lavoro passano da sole; comandi e tutto cio' che e' fuori chiedono sempre.
- **Auto completa**: modifiche e comandi bash passano da soli; fuori dalla cartella chiede ancora. I comandi bash non hanno checkpoint e possono toccare qualsiasi cosa.

Fuori dalla cartella di lavoro chiede **sempre** (tranne bash in "Auto completa", che non ha un percorso da controllare). Prima di ogni
modifica fa un checkpoint: pannello "Checkpoint" -> "Ripristina fino a qui". I comandi bash non sono coperti dai checkpoint.
Comandi bash senza domanda: `%APPDATA%\freeagent\bash-allowlist.json`, un array di prefissi, es. `["git status", "npm test"]`
(solo comandi semplici: niente `;`, `&&`, `|`, `>`, `$(...)`; gli argomenti in piu' sono permessi, quindi tieni le voci strette).

## Sub-agenti (Fase 3)
`config/agents.json`: con `agents` vuoto (default) il tool `delegate` non esiste e c'e' un solo agente. Per attivarli copia le voci di
`_example` in `agents`, es. un `analyst` su un provider e un `editor` su un altro. Ogni sub-agente ha nome, descrizione, provider
(piu' `fallback`), modello, tool consentiti (`read`, `glob`, `grep`, `write`, `edit`, `bash`; mai `delegate`) e `maxSteps`.
L'agente principale puo' mettere piu' blocchi `delegate` nella stessa risposta: partono in parallelo, ognuno in una propria chat
(stessa sessione di login), e tornano con un breve rapporto. I permessi valgono anche per loro e la richiesta di approvazione dice chi la fa.
Il pannello **Agenti** mostra lo stato di ognuno (**Mostra** affianca la sua chat). **Ferma** ferma tutti.
Limiti per non stressare i siti gratuiti (in `limits`, letti all'avvio): 2 chat contemporanee per provider, 1,5 s tra due avvii; dopo un
messaggio di "limite raggiunto" il provider riposa 10 minuti e un sub-agente passa al provider di `fallback` oppure aspetta fino a 2 minuti.

## Skill e ponytail (Fase 5)
Una skill e' una cartella con `SKILL.md` (frontmatter `name` + `description`, poi le istruzioni), come in Claude Code. Quelle incluse stanno in
`skills/<nome>/`, le tue in `%APPDATA%\freeagent\skills\<nome>\` (a parita' di nome vince la prima, cioe' quella inclusa). Il modello vede solo nome e descrizione
nel primo messaggio e legge il testo con `load_skill` quando serve. Un sub-agente vede solo le skill elencate in `skills` nella sua definizione.

**ponytail** e' importata dal repo originale (DietrichGebert/ponytail, licenza MIT, commit `9b58c1ffb7`, vedi `skills/ponytail/SOURCE.json`) senza riscriverla;
`npm run import:ponytail` la riscarica (controlla la licenza). E' una regola sempre attiva: finisce nel primo messaggio di TUTTI gli agenti, sub-agenti compresi.
Livelli lite / full / ultra, spenta con "Spento". Si cambia dal pannello **Skill** o scrivendo come task `/ponytail ultra`, `/ponytail` (= full),
`stop ponytail` o `normal mode` (se dopo il comando scrivi altro, quello e' il compito). Il livello resta salvato tra un avvio e l'altro (default: full).

## Chat lunga
Quando una chat ha trasportato circa 120000 caratteri l'agente si fa scrivere un riepilogo, apre una chat nuova, ripete il compito con il riepilogo e i
risultati ancora da consegnare, e riparte (al massimo 5 volte per compito).

## MCP e Blender (Fase 4)
`config/mcp.json` ha il formato di `.mcp.json` (`mcpServers`: `command`/`args`/`env` oppure `url`) piu' una sezione `freeagent` per ogni server:
`concurrency`, `maxInstances`, `minFreeMemMB`, `launch` (come avviare il processo; segnaposto `{blenderExe}` `{agentDir}` `{ready}` `{port}` `{agent}` `{server}` e `%VAR%`;
`ready` e' una regex con un gruppo, di solito `MCP_URL=(\S+)`), `headless` e `launchUi`, `initCalls`, `health`, `closeCall`, `allowTools` / `denyTools` / `readOnlyTools` (jolly `*`),
`mainAccess`. Il file si rilegge a ogni task se nessun server e' in uso. Un sub-agente usa un server se e' elencato in `mcp` nella sua definizione in `agents.json`.

**Accendere, spegnere, aggiungere dall'app** (scheda Strumenti > MCP): ogni server ha un interruttore (spento = resta configurato ma nessun agente lo vede e non viene mai avviato; la scelta e' in
`%APPDATA%\freeagent\settings.json`). **+ Aggiungi server**: incolla quello che trovi nel README di un server (il JSON di Claude Desktop / Cursor / VS Code, anche con piu' server; un comando come
`npx -y @scope/server`; `claude mcp add ...`; o un indirizzo), l'app lo legge senza avviare nulla, ti mostra nome, comando e avvisi e lo salva in `%APPDATA%\freeagent\mcp.user.json` (stesso formato
di `config/mcp.json`, modificabile a mano; un nome uguale a uno incluso viene ignorato). **Prova** avvia il server da solo, elenca i tool e lo spegne. **Rimuovi** vale per i tuoi; quelli inclusi si spengono soltanto.
Non si cambia nulla mentre un task e' in corso. Un server su un indirizzo `https://` e' segnato "in rete" (quello che gli mandi esce dal PC); `http://` in chiaro solo verso `127.0.0.1`. Intestazioni e login
non sono supportati. Le variabili d'ambiente (chiavi) restano scritte in chiaro in `mcp.user.json` e non compaiono mai nel pannello.

**Quale modalita'** (dalla riproduzione in `tests/mcp-concurrency.test.ts`): `instance-per-agent` = un processo per agente, parallelo e isolato (Blender); `lease` = un agente alla volta per
TUTTO il suo lavoro, gli altri aspettano con il messaggio "server occupato, in coda" (default per i server con stato che non puoi duplicare); `serialized` = una chiamata alla volta, NON protegge una
sequenza di comandi (la scena viene sbagliata lo stesso) e ritenta con attesa crescente le connessioni rifiutate; `shared` = chiamate in parallelo, solo per server senza stato.

**Cosa vede il modello**: nel primo messaggio l'elenco dei server (e dei loro tool se noti), poi solo due tool: `describe_tool` (nomi, oppure schema di un tool) e `mcp_call`. I risultati sono **dati non fidati**:
avvolti da un'intestazione, con i blocchi di codice e il markup dei tool disinnescati; se il testo sembra dare ordini ("ignora le istruzioni precedenti", un blocco `tool`...) la UI avvisa e la
prossima modifica o il prossimo comando **chiedono conferma anche in Auto**. `mcp_call` segue la regola della scrittura (chiede in "Chiedi prima", passa in Auto); i tool in `readOnlyTools` seguono quella della lettura.

**Blender senza finestra** (profilo incluso): un Blender 5.x per agente (`--background`), ognuno nella sua cartella `%APPDATA%\freeagent\mcp-work\blender\<agente>`, fino a 10 insieme (e solo se restano 2 GB di RAM liberi).
Misurato su questo PC con Blender 5.1: 10 istanze in parallelo pronte e funzionanti in 9,4 s, circa 256 MB l'una, ciascuna con la propria scena. Usa l'add-on di terzi `dcc-mcp-blender` (MIT; porta con se' programmi nativi
della dipendenza `dcc-mcp-server`), installato una volta con Blender stesso in una cartella privata:
`"C:\Program Files\Blender Foundation\Blender 5.1\5.1\python\bin\python.exe" -m pip install --target "%APPDATA%\freeagent\mcp\dcc-mcp-blender" dcc-mcp-blender`.
**I tool di terze parti sono spenti**: dei suoi ~30 tool agli agenti arrivano solo `execute_python` e `get_blender_info` (`allowTools`), cosi' lavorano con `bpy` e non con strumenti che non hai.
Ogni agente salva il suo `.blend` nella sua cartella e l'agente principale li unisce (append/link). I processi si chiudono quando l'agente finisce o all'uscita dall'app; dopo un crash il registro `mcp-pids.json`
li chiude al riavvio. Per vedere il lavoro in una finestra: `"headless": false` e un `launchUi` (senza `--background`, con l'add-on avviato dall'interfaccia).

## Provare un task dal vivo senza la UI (`scripts/live-run.mjs`)
`npm run build`, poi `node scripts/live-run.mjs <provider> <cartella> "<task>" [immagine] [minuti]` avvia l'app con una porta di debug, lancia UN task con la stessa API della UI e stampa gli eventi
(`LIVE_LOG=file` li salva interi, `LIVE_EXE=release/win-unpacked/FreeAgent.exe` prova l'exe). Manda messaggi VERI dagli account loggati e l'app deve essere chiusa (stesso profilo).

## Modelli (Fase 2)
`config/models.json` e' il registro, modificabile: provider, id, etichetta, capacita', affidabilita' con i tool, limiti, note. Nessun nome di
modello e' scritto nel codice. Se i selettori del provider descrivono un menu dei modelli, "Leggi modelli dalla pagina" aggiunge quelli veri.

## Aggiungere un provider
Servono i selettori reali della pagina, che non si inventano. Con l'app chiusa: `npm run inspect -- <provider>`, login a mano (email e password),
poi menu **Inspect > Cattura automatica (2 min)** (per le immagini: apri anche una volta il menu di allegato e carica un file, serve il percorso dei clic e la miniatura finita) e scrivi due messaggi lunghi al modello ("conta da 1 a 150, un numero per riga, poi un
blocco di codice python"). Alla fine in `inspect-out/` ci sono i file `<provider>.auto.*.json` + `index`: mandali tutti. Sono redatti
(niente testo dei messaggi, titoli di chat o valori degli input): rileggili comunque prima di incollarli.

## Struttura
`contracts/` interfacce · `src/main/agent/` parser, loop, bootstrap · `src/main/providers/` adapter generico guidato dai selettori ·
`src/main/tools/` read, glob, grep, write, edit · `src/main/` sandbox, policy, permissions, allowlist, bash, checkpoint, settings, scheduler,
orchestrator, usage, models · `config/` provider, selettori, modelli, sub-agenti · `tools/inspect/` ispezione e cattura automatica ·
`src/renderer/` UI · `tests/` fixture e test di integrazione (compresa la riproduzione del problema MCP).
