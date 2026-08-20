# Portal de Proveedores Adsemble

Reconstrucción propia del Vendor Portal de Adsemble (antes en
`portalproveedores.adsemble.do`, operado por un tercero sobre Supabase + n8n).
Este repo tiene el código real de la reconstrucción **y** el material de
ingeniería inversa que sirvió de base.

## Estructura

| Ruta | Qué es |
|------|--------|
| `app/` | Frontend (Vite + React + TS + Zustand + Tailwind) — código real, desplegado en `proveedores.jfmcss.com` |
| `infra/supabase/` | Edge Functions (integración con Business Central, OCR) que corren sobre el Supabase self-hosted — ver `infra/supabase/README.md` |
| `docs/` | Arquitectura, esquema de base de datos, integración con BC, y el **plan de implementación** mapeado a los 15 días comprometidos con Adsemble |
| `docs/BITACORA.md` | **Registro vivo de avance** — qué se hizo, qué falta, actualizado en cada sesión de trabajo |
| `build-original/`, `index-beautified.js`, `extraido/` | Material de ingeniería inversa del portal legacy (solo se tuvo acceso al bundle compilado, nunca al código fuente original) — usado como referencia para replicar esquema, rutas y textos |

## Por dónde empezar

1. `docs/BITACORA.md` — estado actual, qué está hecho y qué falta.
2. `docs/IMPLEMENTATION_PLAN.md` — el plan de cierre, mapeado al cronograma comprometido.
3. `docs/VENDOR_PORTAL_ARCHITECTURE.md` — cómo está armado el sistema.

## Material de ingeniería inversa (legacy)

Generado el 2026-07-22 a partir de `https://portalproveedores.adsemble.do` —
solo el *build* compilado estaba disponible, sin código fuente original.

- `index-beautified.js` — el bundle formateado, usado para **entender la lógica** original (llamadas a Supabase, flujos, validaciones).
- `extraido/00-supabase-config.md` — config del Supabase del proveedor original.
- `extraido/01-esquema-tablas.md` — tablas, columnas y RPCs reconstruidas.
- `extraido/02-rutas-y-modulos.md` — rutas y ciclo de estados de factura, incluye bugs legacy conocidos.
- `extraido/03-automatizacion.md` — webhooks del n8n original.
- `extraido/textos-es.json` / `textos-en.json` — textos de interfaz, reutilizados (corrigiendo acentos) en `app/`.
