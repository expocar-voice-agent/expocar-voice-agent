# Deploy Render - Expocar

Questo file serve per completare il deploy appena si ha accesso a Render.

## Metodo consigliato

1. Caricare il progetto su GitHub oppure importare lo zip `expocar-voice-agent-production.zip`.
2. Creare un servizio Render:

```text
Type: Web Service
Runtime: Docker
Name: expocar-voice-agent
Health check path: /health
```

3. Inserire le variabili presenti in `.env.production.values`.
4. Dopo il deploy, copiare l'URL Render in:

```text
PUBLIC_BASE_URL=https://URL_RENDER
```

5. In OpenAI Platform creare il webhook:

```text
URL: https://URL_RENDER/openai/realtime/webhook
Event: realtime.call.incoming
```

6. Copiare il signing secret OpenAI in Render:

```text
OPENAI_WEBHOOK_SECRET=whsec_...
```

7. Eseguire i test:

```text
https://URL_RENDER/health
https://URL_RENDER/inventory/test?model=Q3
https://URL_RENDER/calendar/slots
https://URL_RENDER/admin/self-test
```

## DIDWW

Il trunk SIP deve puntare a:

```text
sip:proj_owe9TfnPUZWqeBol6XKWC17M@sip.api.openai.com;transport=tls
```

Appena DIDWW approva il numero `+390809997271`, assegnarlo al trunk `Expocar Marco OpenAI`.
