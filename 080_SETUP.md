# Expocar - numero Bari 080

Stato attuale:
- L'agente Expocar e pronto e supera i pre-test locali.
- Numero pubblico da usare: `+39 080 999 7271`.
- Twilio Pro risponde correttamente, ma per l'Italia espone via API solo risorse Mobile e TollFree.
- Il fisso geografico locale `080` non e acquistabile via API Twilio standard.
- Si puo saltare Twilio per le chiamate usando DIDWW SIP diretto verso OpenAI Realtime.

Strada consigliata senza Twilio:
1. Attivare e usare il numero geografico Bari indicato: `+39 080 999 7271`.
2. Project ID OpenAI configurato: `proj_owe9TfnPUZWqeBol6XKWC17M`.
3. In OpenAI Platform creare un webhook per gli eventi Realtime verso:
   `https://DOMINIO_PUBBLICO/openai/realtime/webhook`
4. In DIDWW creare un Inbound SIP Trunk:
   - Friendly name: `Expocar Marco OpenAI`
   - SIP URI completa: `sip:proj_owe9TfnPUZWqeBol6XKWC17M@sip.api.openai.com;transport=tls`
   - Routing method: Static SIP URI
   - User part of R-URI: `proj_owe9TfnPUZWqeBol6XKWC17M`
   - Host: `sip.api.openai.com`
   - Transport: `TLS`
   - Port: `5061`, se richiesto dal pannello
   - Authentication: disabilitata, salvo diversa richiesta OpenAI/DIDWW
5. Assegnare il trunk `Expocar Marco OpenAI` al DID `+390809997271`.
6. Il server Expocar accetta la chiamata, avvia Marco e usa gli strumenti gia pronti:
   annunci MultiGestionale, disponibilita Google Calendar, creazione appuntamento e WhatsApp.

Strada provvisoria con Twilio:
1. In DIDWW creare un Inbound PSTN Trunk:
   - Friendly name: `Expocar Marco Twilio`
   - PSTN phone number: `+18722595539`
   - Capacity limit: `Unlimited`, oppure `1` per test iniziale.
2. Assegnare il trunk `Expocar Marco Twilio` al DID `+390809997271`.
3. Aggiornare Twilio Voice Webhook verso il dominio pubblico attivo del server:
   `https://DOMINIO_PUBBLICO/twilio/voice`

Provider da valutare:
- DIDWW: ha pagina specifica per Italy / Bari / 39-080 e supporto SIP trunking.
- MessageNet: offre numerazioni VoIP geografiche con prefissi locali.
- Telobal/Belfabriek: offrono numeri virtuali Bari 080 con inoltro, da verificare per inoltro SIP diretto.

Alternativa Twilio:
- Aprire un ordine "Exclusive Number" o portabilita su Twilio per un numero locale italiano 080.
- Questa strada puo richiedere documenti/regulatory bundle e tempi di approvazione.

Pre-test gia verificati:
- Saluto: "Expocar, buongiorno, sono Marco. In cosa posso esserle utile?"
- Inventario MultiGestionale: OK.
- Google Calendar: OK.
- OpenAI Realtime: OK.
- Twilio API: OK.
- Endpoint SIP OpenAI: pronto.
