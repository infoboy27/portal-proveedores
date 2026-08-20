# Rutas del frontend y módulos

App React + React Router (SPA). Rutas extraídas del bundle.

## Públicas (sin sesión)

| Ruta | Pantalla |
|------|----------|
| `/login` | Inicio de sesión |
| `/reset-password` | Restablecer contraseña |
| `/verify` | Verificación de cuenta |

## Privadas (dentro del panel)

| Ruta | Módulo |
|------|--------|
| `/` | Dashboard (KPIs, facturas recientes, actividad) |
| `/companies` | Empresas (lista) |
| `/companies/:companyId` | Detalle de empresa |
| `/users` | Usuarios (gestión de accesos y roles) |
| `/suppliers` | Proveedores |
| `/orders` | Órdenes de compra (lista) |
| `/orders/:orderId` | Detalle de orden |
| `/invoices` | Facturas (lista) |
| `/invoices/:invoiceId` | Revisar factura (detalle) |
| `/approvals` | Aprobaciones pendientes |
| `/exports` | Monitoreo de exportaciones a BC |
| `/audit` | Historial de auditoría |
| `*` | Not found |

## Notas de comportamiento observadas (auditoría)

- **Dashboard:** el KPI "Usuarios gestionados" (2420) no coincide con `/users` (vacío). Contador mal calculado.
- **Auditoría / actividad:** el mensaje "Factura vinculada a la orden ." omite el número de orden (plantilla con hueco vacío).
- **Proveedores:** la 4ª tarjeta de estadística no tiene título.
- **Detalle de factura:** estado "No Validado / No disponible" (validación sin resultado) y "Líneas de la orden: SIN DATOS".
- **Aprobaciones:** el texto del estado vacío se corta a la derecha (overflow).
- **Empresas:** muestra el GUID crudo de BC como "Código".
- **Todo el UI:** sin acentos ortográficos en español.
