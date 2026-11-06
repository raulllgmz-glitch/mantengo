# MantenGO · Links únicos de servicio

Cada servicio cerrado tiene un link como `https://TU-DOMINIO/s/<token>` que se puede reenviar por WhatsApp. Muestra el folio, el tipo de servicio, el establecimiento, el comentario de cierre y las fotos de evidencia, con la identidad de MantenGO.

```
Glide (botón Compartir) ──► link /s/<token> ──► Netlify Function ──► Airtable (solo lectura)
```

- La página se arma **en el servidor**, así WhatsApp muestra una vista previa con el folio y la primera foto.
- El token de Airtable vive solo en Netlify. Nunca llega al navegador.
- La función pide **solo** estos campos: Folio, Tipo de Servicio, Solicitud Falla, Establecimiento, Dirección, Fecha de Cierre, Comentario Cierre, Serie y Evidencias. Los montos y las facturas no se piden.
- El HTML no se guarda en caché, así las URLs de fotos de Airtable (que caducan en pocas horas) siempre llegan frescas.

## 1. Probarla ya (sin Airtable)

Después de desplegar, abre `https://TU-DOMINIO/s/demo`. Es una vista con datos ficticios. En producción pon `ALLOW_DEMO=false`.

## 2. Preparar Airtable (tabla Servicios)

Agrega dos campos:

| Campo | Tipo | Para qué |
|---|---|---|
| `Token Público` | Texto de una línea | Parte secreta del link. Aleatorio, de 24 caracteres. |
| `Link activo` | Checkbox | Interruptor para apagar un link. |

La función solo muestra servicios con `Link activo` marcado, `Fecha de Cierre` llena y un token que coincida exactamente.

**Generar el token automáticamente.** En Airtable crea una automatización:

- Disparador: *Cuando un registro cumple condiciones*. Condiciones: `Fecha de Cierre` no está vacío **y** `Token Público` está vacío.
- Acción 1: *Run script*, con una variable de entrada `recordId` que apunte al ID del registro.
- Acción 2: *Update record* con `Link activo` marcado, o ponlo dentro del script.

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

## 3. Token de Airtable para la función

1. Airtable → Developer hub → *Personal access tokens* → crear uno.
2. Permiso: solo `data.records:read`.
3. Acceso: solo la base de MantenGO.

## 4. Desplegar en Netlify

Arrastrar la carpeta a Netlify **no** publica las funciones. Usa Git o la CLI:

```bash
npm i -g netlify-cli
netlify login
netlify init            # o: netlify link
netlify env:set AIRTABLE_TOKEN "pat..."
netlify env:set ALLOW_DEMO true      # cámbialo a false al terminar las pruebas
netlify deploy --prod
```

Variables opcionales: `AIRTABLE_BASE_ID` y `AIRTABLE_TABLE_ID`. Por defecto apuntan a la base y la tabla Servicios de MantenGO.

**Dominio.** Conviene un subdominio propio, por ejemplo `servicio.mantengo.mx`, para que el link se vea de la marca. Se configura en Netlify → Domain management.

## 5. Botón "Compartir" en Glide

1. Columna de plantilla `Link servicio`: `https://TU-DOMINIO/s/` + `Token Público`.
2. Columna de plantilla `Mensaje`: `Hola, te comparto la evidencia del servicio ` + `Folio` + `: ` + `Link servicio`.
3. Botón con la acción *Open link* a `https://wa.me/?text=` + el mensaje codificado para URL. Si tu plan de Glide trae una acción de compartir, también sirve.
4. Muestra el botón solo cuando `Token Público` no esté vacío.

## 6. Qué cambiar si tus campos se llaman distinto

Todos los nombres están en el objeto `F` al inicio de `netlify/functions/servicio.js`.

## Notas

- Es un link "al portador": quien lo recibe lo puede reenviar. Para cortarlo, desmarca `Link activo`. Para invalidarlo y generar otro, borra `Token Público` y deja que la automatización cree uno nuevo.
- Solo se muestran fotos. Videos y otros adjuntos se ignoran.
- La vista previa de WhatsApp se guarda en el chat al enviar el link. Si cambias las fotos después, el link siempre muestra las actuales, pero un mensaje ya enviado conserva su miniatura.
