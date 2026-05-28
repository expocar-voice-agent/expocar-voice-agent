# Expocar Voice Agent

Starter kit per un agente telefonico che risponde ai clienti Expocar, consulta gli annunci da MultiGestionale Motori, propone il servizio di importazione auto, fissa appuntamenti su Google Calendar e puo inviare conferme WhatsApp.

Per la messa online stabile vedi [DEPLOY.md](DEPLOY.md).

## Cosa fa

- Riceve chiamate dal numero DIDWW `+39 080 999 7271` tramite OpenAI Realtime SIP.
- Mantiene anche il vecchio bridge Twilio Voice come opzione di fallback.
- Cerca auto disponibili tramite MultiGestionale Motori.
- Se non trova l'auto giusta, propone importazione auto da tutta Europa.
- Controlla disponibilita calendario lunedi-venerdi 10:00-19:00.
- Fissa appuntamenti da 60 minuti, ogni ora, con almeno 6 ore di preavviso.
- Invia WhatsApp con posizione sede: `https://maps.app.goo.gl/dZk69BM7kEjkKj8r6`.

## Setup

1. Installa dipendenze:

   ```bash
   npm install
   ```

2. Copia `.env.example` in `.env` e compila i valori sul tuo computer/server. Non inviare mai `.env` in chat o su Git.

3. Avvia il server:

   ```bash
   npm run dev
   ```

   Su Windows puoi avviare server e tunnel pubblico insieme:

   ```powershell
   .\scripts\start-agent.ps1
   ```

4. Esponi il server in HTTPS, per esempio con ngrok, e imposta:

   ```text
   PUBLIC_BASE_URL=https://tuo-dominio-https
   ```

5. Per la configurazione senza Twilio, collega DIDWW a OpenAI Realtime SIP:

   ```text
   sip:PROJECT_ID@sip.api.openai.com;transport=tls
   ```

   In OpenAI Platform configura il webhook:

   ```text
   POST https://tuo-dominio-https/openai/realtime/webhook
   ```

6. Se usi il fallback Twilio Voice, configura il webhook chiamate in ingresso:

   ```text
   POST https://tuo-dominio-https/twilio/voice
   ```

## Google Calendar

Se la tua organizzazione blocca la creazione di chiavi service account, usa OAuth.

Variabili da compilare:

```text
GOOGLE_AUTH_MODE=oauth
GOOGLE_CALENDAR_ID=cafarogiuseppelive@gmail.com
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
```

Se il test calendario restituisce `unauthorized_client`, rigenera il refresh token:

1. In Google Cloud apri il client OAuth.
2. Aggiungi tra gli URI di reindirizzamento autorizzati:

   ```text
   https://developers.google.com/oauthplayground
   ```

3. Nella schermata OAuth consent, aggiungi `cafarogiuseppelive@gmail.com` come test user se l'app e in modalita test.
4. In OAuth Playground attiva "Use your own OAuth credentials".
5. Usa lo scope:

   ```text
   https://www.googleapis.com/auth/calendar
   ```

6. Autorizza di nuovo e copia il nuovo `refresh_token`.

In alternativa, il progetto ha un flusso automatico locale:

1. Nel client OAuth Google aggiungi questo redirect URI:

   ```text
   http://localhost:3000/google/oauth/callback
   ```

2. Avvia il server e apri:

   ```text
   http://localhost:3000/google/auth
   ```

3. Accedi con l'account del calendario e concedi i permessi.
4. Il backend salva automaticamente `GOOGLE_OAUTH_REFRESH_TOKEN` nel file `.env`.
5. Riavvia il server e testa:

   ```text
   http://localhost:3000/calendar/slots
   ```

Il service account resta supportato impostando `GOOGLE_AUTH_MODE=service_account`, ma non e necessario per questa configurazione.

## Variabili sensibili

Rigenera e conserva solo in `.env`:

- `OPENAI_API_KEY`
- `TWILIO_AUTH_TOKEN`
- `MULTIGESTIONALE_USER_API`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`

Le chiavi incollate in chat devono essere revocate.
