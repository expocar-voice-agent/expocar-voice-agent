# Render build failed

Se Render mostra:

```text
Exited with status 10 while building your code
```

verificare prima queste cose:

1. Nel repository GitHub devono esserci i file estratti, non solo lo zip.
2. La radice del repository deve contenere:

```text
Dockerfile
package.json
package-lock.json
src/
scripts/
```

3. In Render:

```text
Runtime: Docker
Dockerfile path: ./Dockerfile
Build Command: vuoto
Start Command: vuoto
Health Check Path: /health
```

4. Non caricare file segreti:

```text
.env
.env.production.values
```

5. Se Render continua a fallire, aprire Logs e copiare le righe subito sopra:

```text
Exited with status 10
```
