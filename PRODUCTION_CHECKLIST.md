# Expocar produzione

Obiettivo:

```text
+39 080 999 7271 -> DIDWW SIP -> OpenAI Realtime -> server Expocar
```

## Valori gia decisi

```text
Numero pubblico: +390809997271
OpenAI Project ID: proj_owe9TfnPUZWqeBol6XKWC17M
DIDWW SIP URI: sip:proj_owe9TfnPUZWqeBol6XKWC17M@sip.api.openai.com;transport=tls
Webhook OpenAI: https://DOMINIO_PUBBLICO/openai/realtime/webhook
```

## Accessi/token minimi per completare tutto via automazione

```text
DIDWW_API_KEY
RENDER_API_KEY
GITHUB_TOKEN oppure repository GitHub gia creato/collegato a Render
```

OpenAI webhook: al momento la documentazione OpenAI indica la creazione dal pannello:

```text
Platform -> Settings -> Project -> Webhooks
```

Evento da abilitare:

```text
realtime.call.incoming
```

Dopo la creazione del webhook, OpenAI mostra un signing secret. Copiarlo in hosting come:

```text
OPENAI_WEBHOOK_SECRET
```

## Variabili hosting obbligatorie

Copiarle dal file locale `.env` nell'hosting, senza virgolette:

```text
OPENAI_API_KEY
OPENAI_PROJECT_ID
OPENAI_WEBHOOK_SECRET
ADMIN_TOKEN
OPENAI_REALTIME_MODEL
OPENAI_REALTIME_VOICE
BUSINESS_PUBLIC_PHONE
DIDWW_API_KEY
DIDWW_DID_NUMBER
MULTIGESTIONALE_USER_API
MULTIGESTIONALE_ENGINE
GOOGLE_CALENDAR_ID
GOOGLE_AUTH_MODE
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
BUSINESS_TIMEZONE
BUSINESS_OPEN_HOUR
BUSINESS_CLOSE_HOUR
APPOINTMENT_DURATION_MINUTES
APPOINTMENT_MIN_NOTICE_HOURS
APPOINTMENT_SLOT_MINUTES
LOCATION_URL
```

Twilio e opzionale. Non serve per ricevere chiamate via DIDWW/OpenAI.

## Test pre-finale

Dopo il deploy:

```text
GET https://DOMINIO_PUBBLICO/health
GET https://DOMINIO_PUBBLICO/inventory/test?model=Q3
GET https://DOMINIO_PUBBLICO/calendar/slots
GET https://DOMINIO_PUBBLICO/admin/self-test
POST https://DOMINIO_PUBBLICO/openai/realtime/webhook
```

Solo dopo questi test si chiama `0809997271`.

## Numero DIDWW in review

Finche DIDWW mostra "Your end user details are currently under review", il DID `+390809997271` puo non essere visibile via API e non puo ancora essere assegnato al trunk.

Nel frattempo sono pronti:

```text
RUN_DIDWW_CONFIG.bat
WAIT_DIDWW_NUMBER.bat
```

`RUN_DIDWW_CONFIG.bat` prova a creare/riusare il trunk SIP e ad assegnare il DID se visibile.

`WAIT_DIDWW_NUMBER.bat` puo restare aperto e riprovare periodicamente fino a quando DIDWW rende disponibile il numero.
