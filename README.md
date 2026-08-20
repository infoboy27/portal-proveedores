# Portal de Proveedores Adsemble — material recuperado

Lo que se pudo obtener del sitio en producción `https://portalproveedores.adsemble.do`.

> ⚠️ **Importante:** el sitio publica solo el *build* compilado y minificado (React/Vite).
> El **código fuente original (componentes JSX/TS) NO está disponible** — solo lo tiene el
> proveedor que lo desarrolló. Lo que hay aquí es: (1) los archivos desplegados tal cual,
> (2) el bundle formateado para lectura, y (3) todo lo útil extraído por ingeniería inversa.
> El código fuente limpio y propio saldrá de la **reconstrucción** (ver el plan del proyecto).

## Contenido

| Ruta | Qué es |
|------|--------|
| `build-original/index.html` | HTML shell desplegado |
| `build-original/assets/index-C-1YYMu8.js` | Bundle JS de la app (minificado, 686 KB) |
| `build-original/assets/index-CUsZfOKg.css` | CSS compilado (Tailwind) |
| `index-beautified.js` | El mismo bundle **formateado** (legible; nombres de variables siguen ofuscados) |
| `extraido/00-supabase-config.md` | URL y clave pública de Supabase, storage |
| `extraido/01-esquema-tablas.md` | Tablas, columnas confirmadas y funciones RPC |
| `extraido/02-rutas-y-modulos.md` | Rutas del frontend y estados del ciclo de factura |
| `extraido/03-automatizacion.md` | Webhooks de extracción y visualización de PDF |
| `extraido/textos-es.json` | 394 textos de interfaz en español |
| `extraido/textos-en.json` | 324 textos de interfaz en inglés |

## Cómo usarlo

- El `index-beautified.js` sirve para **entender la lógica** (llamadas a Supabase, flujos, validaciones).
- Lo de `extraido/` es la base para **replicar el esquema y los textos** en la reconstrucción.
- Los `textos-*.json` se reutilizan directamente (corrigiendo los acentos que faltan).

Generado el 2026-07-22 a partir del sitio en producción.
