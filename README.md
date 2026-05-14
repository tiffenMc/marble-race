# 🎱 MARBLE RACE — Instrucciones de despliegue en Render.com

## ¿Qué hay aquí?
- `server.js` — servidor Node.js con Socket.io
- `package.json` — dependencias
- `public/index.html` — página de inicio (selector Host/Espectador)
- `public/host.html` — **TU página** (panel de control)
- `public/game.html` — **página de tus amigos** (la carrera)

---

## 🚀 Subir a Render.com (10 minutos)

### Paso 1 — Sube el código a GitHub
1. Ve a [github.com](https://github.com) y crea una cuenta si no tienes
2. Crea un nuevo repositorio (ej: `marble-race`) — ponlo **Público**
3. Sube todos estos archivos al repositorio
   - Puedes arrastrar los archivos directamente en la web de GitHub

### Paso 2 — Conecta con Render
1. Ve a [render.com](https://render.com) y regístrate con Google
2. Haz clic en **"New +"** → **"Web Service"**
3. Conecta tu cuenta de GitHub
4. Selecciona el repositorio `marble-race`

### Paso 3 — Configura el servicio
En la pantalla de configuración pon:
- **Name**: marble-race (o el que quieras)
- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Instance Type**: Free

Haz clic en **"Create Web Service"**

### Paso 4 — ¡Listo!
Render te dará una URL tipo:
`https://marble-race-xxxx.onrender.com`

- **Tú entras a**: `https://marble-race-xxxx.onrender.com/host.html`
- **Tus amigos entran a**: `https://marble-race-xxxx.onrender.com/game.html`

---

## 🎮 Cómo jugar

1. Tú abres `/host.html`
2. Añades canicas (nombre + foto + sonido opcional)
3. Pulsas **"Abrir sala de espera"** → tus amigos ven la pantalla de espera
4. Pulsas **"Mostrar canicas en escenario"** → todos ven las canicas preparadas
5. Pulsas **"INICIAR CARRERA"** → cuenta atrás 3,2,1 y caen
6. La primera canica en llegar a la meta gana
7. El ganador sale con confeti y puntos
8. Pulsas **"Siguiente ronda"** → nuevo mapa aleatorio

---

## ⚠️ Nota sobre Render Free
En el plan gratuito, el servidor se "duerme" tras 15 min sin uso.
La primera vez que entres puede tardar 30-60 segundos en arrancar.
Después funciona normal.
