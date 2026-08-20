# Configuración de Supabase (del sistema actual)

> Estos valores apuntan al Supabase **del proveedor** (`smartautomation.cloud`).
> Sirven de referencia para replicar el esquema. En la reconstrucción se usa **tu propio Supabase**.

## Conexión

| Dato | Valor |
|------|-------|
| URL del proyecto | `https://invoicedb.smartautomation.cloud` |
| Clave pública (`anon`) | ver abajo — es pública por diseño (protegida por RLS) |

```
SUPABASE_URL=https://invoicedb.smartautomation.cloud
SUPABASE_ANON_KEY=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc2NDUzNzAwMCwiZXhwIjo0OTIwMjEwNjAwLCJyb2xlIjoiYW5vbiJ9.Ik0Fi8Ra1eWA7xgnc4_SK6xA-dhgHgeWZJq5Olc5ZS4
```

La clave `anon` decodificada indica: `iss: supabase`, `role: anon`, emitida 2025-11-30, expira ~2126.
Es la clave pública normal de cualquier app Supabase; **no** es una filtración de credencial secreta.
La seguridad real depende de las políticas RLS del proyecto (no verificables sin acceso admin).

## Almacenamiento (Storage)

| Bucket | Uso |
|--------|-----|
| `invoices` | PDFs de las facturas. Se accede con URLs firmadas (`createSignedUrl`). |

## Autenticación

Supabase Auth con correo/contraseña. Rutas: `/login`, `/reset-password`, `/verify`.
El perfil y el rol de cada usuario viven en la tabla `user_profiles`.
