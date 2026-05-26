# Deploy Cloud

Il test locale e utile per inventario e calendario, ma il server di produzione deve stare su un hosting pubblico HTTPS stabile. Questo evita i blocchi di rete locali e sostituisce i tunnel temporanei `trycloudflare.com`.

La configurazione consigliata per Expocar e senza Twilio per le telefonate:

```text
DIDWW +39 080 999 7271 -> OpenAI Realtime SIP -> server Expocar webhook
```

## Opzione semplice: Render

1. Crea un nuovo servizio **Web Service**.
2. Collega questo progetto Git oppure carica la cartella.
3. Runtime: **Docker**.
4. Porta: `3000`.
5. Aggiungi le variabili ambiente del file `.env`, senza virgolette.
6. Dopo il deploy, copia l'URL pubblico Render, per esempio:

   ```text
   https://expocar-voice-agent.onrender.com
   ```

7. In OpenAI Platform imposta un webhook Realtime verso:

   ```text
   https://expocar-voice-agent.onrender.com/openai/realtime/webhook
   ```

8. In DIDWW imposta un Inbound SIP Trunk verso:

   ```text
   sip:PROJECT_ID@sip.api.openai.com;transport=tls
   ```

   Poi assegna il trunk al numero `+390809997271`.

## Variabili richieste

```text
OPENAI_API_KEY=
OPENAI_PROJECT_ID=
OPENAI_WEBHOOK_SECRET=
ADMIN_TOKEN=
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_VOICE=alloy
MULTIGESTIONALE_USER_API=
MULTIGESTIONALE_ENGINE=car
GOOGLE_CALENDAR_ID=
GOOGLE_AUTH_MODE=oauth
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
BUSINESS_TIMEZONE=Europe/Rome
BUSINESS_OPEN_HOUR=10
BUSINESS_CLOSE_HOUR=19
APPOINTMENT_DURATION_MINUTES=60
APPOINTMENT_MIN_NOTICE_HOURS=6
APPOINTMENT_SLOT_MINUTES=60
LOCATION_URL=https://maps.app.goo.gl/dZk69BM7kEjkKj8r6
```

Variabili Twilio opzionali, solo se vuoi mantenere WhatsApp automatico tramite Twilio:

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
SELLER_WHATSAPP_TO=
```

## Test dopo deploy

Apri:

```text
https://tuo-dominio/health
https://tuo-dominio/admin/status
https://tuo-dominio/inventory/test
https://tuo-dominio/calendar/slots
https://tuo-dominio/admin/self-test
```

Poi, quando DIDWW approva il numero e il trunk e assegnato, chiama `0809997271`.
