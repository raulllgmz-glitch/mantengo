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
- La ubicación en vivo del técnico no está incluida: requiere que la app del equipo de campo envíe la posición.
