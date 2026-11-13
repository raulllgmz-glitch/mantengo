# MantenGO · Link único de servicio

Cada servicio tiene un link como `https://TU-DOMINIO/s/<token>` que se puede reenviar por WhatsApp **desde que se crea la solicitud**. El mismo link muestra primero el seguimiento (recibido, programado, en camino, en proceso) y, cuando el servicio termina, el comentario de cierre y las fotos de evidencia.

```
Glide (botón Compartir) ──► link /s/<token> ──► Netlify Function ──► Airtable (solo lectura)
```

- La página se arma **en el servidor**, así WhatsApp muestra una vista previa con el folio y el estatus.
- El token de Airtable vive solo en Netlify. Nunca llega al navegador.
- La función pide **solo** estos campos: Folio, Tipo de Servicio, Solicitud Falla, Establecimiento, Dirección, Coordenadas, Serie, Etapa, Fecha programada, Hora en camino, Técnico, Fecha de Cierre, Comentario Cierre y Evidencias. Los montos y las facturas no se piden.
- La página no se guarda en caché: cada visita lee Airtable y trae URLs de fotos frescas (las de Airtable caducan en pocas horas).
- La página muestra el nombre del establecimiento bajo el título, una barra horizontal con las 5 etapas (la actual resaltada) y un despegable «Ver detalle del seguimiento» con la línea de tiempo completa.
- Si `Coordenadas` es válida, arriba aparece un mapa con el pin del establecimiento (Leaflet con mapa de OpenStreetMap, en tono oscuro; no necesita llaves. Para mucho tráfico conviene un proveedor con llave, como MapTiler, Stadia o Mapbox: se cambia la URL del mapa en `mapCard`). Sin coordenadas, no hay mapa.
- Debajo del estatus hay tres botones: Compartir (WhatsApp con el link), WhatsApp con MantenGO y Llamar.
- La tarjeta «Ubicación» muestra dirección, coordenadas y un botón «Ver en mapa» (Google Maps).
- Mientras el servicio no esté terminado, la página se recarga sola cada 60 segundos.
- Si un campo opcional aún no existe en Airtable, la página funciona sin él.

## 1. Probarla (sin Airtable)

Con `ALLOW_DEMO` distinto de `false`, estas direcciones muestran datos ficticios:

| Dirección | Muestra |
|---|---|
| `/s/demo-recibido` | Solicitud recibida |
| `/s/demo-programado` | Visita programada |
| `/s/demo-encamino` | Técnico en camino |
| `/s/demo-proceso` | Servicio en proceso |
| `/s/demo` | Servicio terminado, con comentario y fotos |

En producción pon `ALLOW_DEMO=false`.

## 2. Preparar Airtable (tabla Servicios)

Campos nuevos:

| Campo | Tipo | Para qué |
|---|---|---|
| `Token Público` | Texto de una línea | Parte secreta del link. Aleatorio, de 24 caracteres. |
| `Link activo` | Checkbox | Interruptor para apagar un link. |
| `Etapa` | Selección única | Opciones, en este orden: `Recibido`, `Programado`, `En camino`, `En proceso`, `Terminado`. |
| `Fecha programada` | Fecha con hora | Visita agendada. Se muestra en hora del centro de México. |
| `Hora en camino` | Fecha con hora | Cuándo salió el técnico. Puede llenarla una automatización al pasar a `En camino`. |
| `Coordenadas` | Texto de una línea | Ya existe. Formato `20.58805, -100.38986` (latitud, longitud). También acepta un link de Google Maps. Si falta o es inválido, el mapa se busca con establecimiento y dirección. |
| `Llegada estimada` | Fecha con hora | Opcional. Muestra «Llega hoy antes de las 11:45 hs» mientras el servicio no termina. Si ya pasó la hora o está vacío, no se muestra. |
| `Lat técnico` | Número, 6 decimales | La escribe el seguimiento en vivo. |
| `Lon técnico` | Número, 6 decimales | La escribe el seguimiento en vivo. |
| `Ubicación actualizada` | Fecha con hora | Cuándo llegó la última posición. Pasados 10 minutos se oculta. |
| `Técnico` | Texto de una línea | Opcional. Se muestra tal cual, por eso conviene poner solo el nombre de pila. |

Reglas de la etapa:
- Si hay `Fecha de Cierre`, el servicio se muestra como **terminado**, sin importar `Etapa`.
- Si `Etapa` está vacía, se deduce: con `Hora en camino` es "en camino", con `Fecha programada` es "programado" y, si no, "recibido".
- Las fotos y el comentario de cierre solo aparecen cuando el servicio está terminado.

**Generar el token al crear el servicio.** Crea una automatización en Airtable:

- Disparador: *Cuando un registro cumple condiciones*, con `Token Público` vacío. También sirve *Cuando se crea un registro*.
- Acción: *Run script*, con una variable de entrada `recordId` que apunte al ID del registro.

```js
let { recordId } = input.config();
let table = base.getTable('Servicios');

if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
  throw new Error('Este entorno no tiene crypto.getRandomValues: no generar el token con Math.random.');
}
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const bytes = new Uint8Array(24);
crypto.getRandomValues(bytes);
let token = '';
for (const b of bytes) token += chars[b % chars.length];

await table.updateRecordAsync(recordId, {
  'Token Público': token,
  'Link activo': true
});
```

> El link **no debe** construirse con el folio ni con el ID del registro: serían fáciles de adivinar.

Los servicios que ya existen no tienen token. Para darles link, deja `Token Público` vacío y corre la automatización sobre ellos, o ejecútala una vez por registro.

**Opcional: hora en camino automática.** Otra automatización: cuando `Etapa` cambie a `En camino` y `Hora en camino` esté vacía, actualizar el registro con la hora actual.

## 3. Token de Airtable para la función

1. Airtable → Developer hub → *Personal access tokens* → crear uno.
2. Permiso: solo `data.records:read`.
3. Acceso: solo la base de MantenGO.

## 4. Desplegar en Netlify

Con GitHub: sube el contenido de esta carpeta al repositorio e impórtalo en Netlify. La configuración ya viene en `netlify.toml`.
Con la terminal:

```bash
npm i -g netlify-cli
netlify login
netlify init
netlify env:set AIRTABLE_TOKEN "pat..."
netlify env:set ALLOW_DEMO true      # cámbialo a false al terminar las pruebas
netlify deploy --prod
```

Los cambios de variables de entorno solo aplican en un despliegue nuevo.

Variables opcionales: `AIRTABLE_BASE_ID` y `AIRTABLE_TABLE_ID`. Por defecto apuntan a la base y la tabla Servicios de MantenGO.

**Dominio.** Conviene un subdominio propio, por ejemplo `servicio.mantengo.mx`, para que el link se vea de la marca (Netlify → Domain management).

## 5. Botón "Compartir" en Glide

1. Columna de plantilla `Link servicio`: `https://TU-DOMINIO/s/` + `Token Público`.
2. Columna de plantilla `Mensaje`: `Hola, te comparto el seguimiento de tu servicio ` + `Folio` + `: ` + `Link servicio`.
3. Botón con la acción *Open link* a `https://wa.me/?text=` + el mensaje codificado para URL. Si tu plan de Glide trae una acción de compartir, también sirve.
4. Muestra el botón solo cuando `Token Público` no esté vacío.

## 6. Qué cambiar si tus campos se llaman distinto

Todos los nombres están en el objeto `F` al inicio de `netlify/functions/servicio.js`.

## Notas

- Es un link "al portador": quien lo recibe lo puede reenviar. Para cortarlo, desmarca `Link activo`. Para invalidarlo y generar otro, borra `Token Público` y deja que la automatización cree uno nuevo.
- Solo se muestran fotos. Videos y otros adjuntos se ignoran.
- La vista previa de WhatsApp se guarda en el chat al enviar el link. El link siempre muestra el estatus actual, pero un mensaje ya enviado conserva su miniatura.

## 7. Seguimiento en vivo del técnico

```
Celular del técnico ──► /t/<token> ──► /api/ubicacion (clave + escritura) ──► Airtable
Cliente ──► /s/<token> ──► mapa con camión y distancia, se actualiza cada 10 s (/p/<token>)
```

**Qué hace**
- El técnico abre `https://TU-DOMINIO/t/<Token Público>` (botón en Glide), escribe la clave del equipo una sola vez y toca **Iniciar viaje**.
- Cada 10 segundos se guarda su posición. La primera vez, el servicio pasa a **En camino** y se llena `Hora en camino`.
- El cliente ve el camión en el mapa y la distancia en línea recta («A 3.2 km»). La página se actualiza sola.
- Se deja de compartir cuando el técnico toca **Detener**, cuando `Etapa` pasa a **En proceso** o **Terminado**, o cuando la última posición tiene más de 10 minutos.

**Configuración**
1. Crea en Servicios los campos `Lat técnico`, `Lon técnico` (número, 6 decimales) y `Ubicación actualizada` (fecha con hora). La opción **En camino** debe existir en `Etapa`.
2. Crea un segundo token de Airtable, solo para escribir, con permisos `data.records:read` y `data.records:write` y acceso solo a la base MantenGO.
3. En Netlify → Environment variables agrega:
   - `AIRTABLE_WRITE_TOKEN`: el token del paso 2.
   - `TRACK_KEY`: una clave del equipo, de 16 caracteres o más. Se comparte con los técnicos. Para cambiarla, cambia esta variable y haz redeploy.
4. Haz un redeploy.
5. En Glide agrega un botón para el equipo: *Open link* a `https://TU-DOMINIO/t/` + `Token Público`.

**Seguridad**
- El token de lectura de la página del cliente sigue siendo solo lectura. La escritura vive en `netlify/functions/ubicacion.js` y exige la clave.
- La clave se queda guardada en el teléfono del técnico. Si se pierde un teléfono, cambia `TRACK_KEY`.
- La posición se escribe solo en el servicio cuyo link abrió el técnico, y solo si está activo y sin terminar.

**Límites**
- La página debe estar abierta y con la pantalla encendida. En iPhone y en muchos Android el navegador deja de enviar si se bloquea la pantalla o se cambia de app. Para eso se pide mantener la pantalla encendida (`Wake Lock`); una app propia lo resolvería del todo.
- La distancia es en línea recta, no por calles. Para minutos de llegada por ruta hace falta un servicio de rutas con llave.
- No se guarda historial: solo la última posición.

## 8. Ficha del punto de venta (liga del técnico)
La liga `/t/<token>` muestra, tras ingresar la clave: fachada, dirección, contacto, teléfono, falla/serie y botones Cómo llegar (Google Maps), Waze, Llamar, WhatsApp y Compartir ubicación.
Campos de Airtable usados: Dirección, Coordenadas ("lat, lon"), Contacto, Telefono, Solicitud Falla, Serie, Tipo de Servicio y, opcional, **Fachada** (adjuntos). Nunca se envían montos ni facturas.
El marcador del técnico en el mapa es `public/assets/camion.png`.

## 9. Uso sin señal (liga del técnico)
`public/sw.js` guarda la página del técnico y la fachada. Si el técnico la abrió al menos una vez con internet, después carga sin datos con los últimos datos del PDV guardados, y al volver la señal envía su posición. Los mapas para navegar deben descargarse en Google Maps/Waze.

## 10. Avance del servicio desde la liga del técnico
Botones "Llegué", fotos de evidencia y "Terminar servicio" (con comentario). Se guardan en una cola del teléfono (IndexedDB) y se envían en orden al haber señal.
- Llegué → Etapa "En proceso" y deja de compartir posición.
- Foto → se reduce a 1600 px y se sube al campo **Evidencias** (requiere que el token de escritura tenga `data.records:write`).
- Terminar → Fecha de Cierre (hoy, hora CDMX), Etapa "Terminado" y Comentario Cierre.

## 11. App de solicitud de servicios (`/n/<código>`)
Cada cliente (tabla **Marca**) tiene una liga personal `https://mantengo.netlify.app/n/<Código solicitud>`. El cliente elige el tipo de servicio, su tienda (o una reciente), marca el pin, cuenta la falla, agrega fotos y la fecha. Se crea un registro en Servicios con Etapa "Recibido", su Token Público y el vínculo al cliente; al terminar ve su folio y la liga de seguimiento `/s/<token>`.

Airtable — tabla **Marca**: `Código solicitud` (texto) y `Acceso activo` (casilla). Opcional: `Liga_Solicitud` = `"https://mantengo.netlify.app/n/"&{Código solicitud}`.
Airtable — tabla **Servicios** (opcionales; si faltan se omiten): `Fecha solicitada` (fecha), `Fotos solicitud` (adjuntos; si no existe, las fotos van a Evidencias).
Variables de Netlify: usa `AIRTABLE_WRITE_TOKEN` (con acceso de lectura y escritura a la base). Opcional `AIRTABLE_MARCA_TABLE_ID`.
Protecciones: código secreto por cliente, casilla "Acceso activo" para apagarlo, máximo 8 solicitudes por hora por cliente, trampa anti-bots, revisión de origen.

## 12. Ruta del día para un cliente (`/r/<código>`)
Liga de solo lectura que muestra los servicios de un cliente programados un día, ordenados por hora, con su estatus en vivo y enlace a cada seguimiento. `?d=manana`, `?d=hoy` o `?d=2026-11-12`.
- Tabla **Marca**: `Código ruta` (texto, secreto) y `Acceso ruta` (casilla). Opcional `Liga_Ruta_Manana` = `"https://mantengo.netlify.app/r/"&{Código ruta}&"?d=manana"`.
- Tabla **Servicios**: `Fecha Programada` debe ser "Fecha con hora" (si solo tiene fecha, la parada dice "Horario por confirmar"); `Cliente` vinculado; `Técnico` opcional.
- La función usa `AIRTABLE_TOKEN` (solo lectura).
Mapa: la ruta muestra un mini mapa con las paradas numeradas (usa el campo `Coordenadas` de Servicios, "lat, lon"). Si hay varias camionetas (distintos valores en `Técnico`), se agrupan por técnico, cada una con su color y su propia numeración.

## 13. Acceso por teléfono + PIN

Páginas `/n` (solicitud) y `/r` (ruta) sin código en la liga: piden el teléfono, mandan un PIN (Twilio Verify) y la sesión
dura 30 días. El teléfono debe estar en la tabla **Contactos** (Nombre, Teléfono, Marca [vínculo], Activo [casilla]).
Variables en Netlify: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`, `SESSION_SECRET` (≥32 caracteres al azar),
`OTP_CHANNEL` (`sms`; `whatsapp` cuando esté listo). Las ligas con código siguen funcionando hasta poner `ALLOW_CODE_LINKS=false`.
Campo opcional en Servicios: `Solicitó` (texto) guarda quién pidió el servicio.

## 14. Carga masiva (`/m`)

Plantilla de Excel por marca (marca y "cargado por" bloqueados, tipo de servicio con lista, hoja protegida), revisión fila por fila
y creación en lotes de 10. Máximo 200 filas por carga. La marca, `Contacto User` y `Tel User` salen siempre de la sesión.
Acepta dirección, coordenadas o link de Google Maps. Opcional: `MASIVA_ROLES` (ej. `Admin,Coordinador`) limita quién puede
usarla según el campo `Roll` de Conactos. Requiere `exceljs` (se instala solo en el deploy de Netlify).

Modo prueba del acceso: `OTP_PIN_PRUEBA=1234` (4 a 8 dígitos) en Netlify permite entrar sin Twilio con ese PIN fijo, solo con teléfonos
registrados en Conactos. Quitar la variable (y redeploy) para volver al PIN real por SMS.
PIN por contacto: columna `PIN` (texto, 4 a 8 dígitos) en Conactos. Si está llena, ese contacto entra con ese PIN y no se manda SMS.

## 15. Buscador de direcciones (Google Places)

En `/n` el campo Dirección usa Google Places Autocomplete (México): al elegir una sugerencia llena la dirección y pone el pin,
que se puede seguir moviendo. Variable en Netlify: `GOOGLE_MAPS_KEY` (clave propia de este proyecto, con restricción de
referencia HTTP a `mantengo.netlify.app/*` y solo las APIs Maps JavaScript y Places). La clave solo se entrega a sesiones válidas
y nunca va en el repositorio. Sin la variable, el campo funciona como texto normal.

## 16. Portal del cliente (`/inicio`)

Pantalla principal tras entrar con teléfono + PIN, según el diseño: Inicio (solicitar, servicio en curso, equipos, servicios, carga masiva,
WhatsApp), Mis servicios (filtros y liga al seguimiento) y Mis equipos (agrupados por `Serie`; sin serie, por establecimiento).
Rutas `/inicio`, `/servicios`, `/equipos` → `app.html`; datos de `/api/cliente` (solo lectura, con sesión). Esta es la liga principal.

### Previsualización editable de la carga masiva
Al subir el Excel, cada fila aparece como una ficha con todos sus campos editables (tipo, establecimiento, falla, dirección/link, coordenadas, serie, contacto, teléfono). Al editar se revalida solo (acción `revisar`) y se actualizan ✓/errores; "Quitar" descarta una fila. El servidor vuelve a validar todo al crear.

### Cambios en solicitud (`/n`)
- Se quitó "Tus tiendas recientes".
- La fecha ahora es un solo selector con mínimo mañana (hora CDMX), ya preseleccionado en mañana. El servidor también rechaza fechas anteriores a mañana (los valores viejos "hoy"/"manana" se guardan como mañana).

### Vista de escritorio (portal)
≥960 px: menú lateral izquierdo, tablero en inicio (CTA, servicio en curso, 4 indicadores, lista de servicios en curso) y cuadrículas de 2–4 columnas en Servicios/Equipos. En celular no cambia.
