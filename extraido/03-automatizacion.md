# Automatización (webhooks del sistema actual)

Estos webhooks viven en el **n8n del proveedor** (`automate.smartautomation.cloud`).
En la reconstrucción se reemplazan por flujos en **tu Make.com**.

## Webhooks usados por el frontend

### 1. Extracción de factura
```
POST https://automate.smartautomation.cloud/webhook/invoice-upload-extract
```
Se llama al subir una factura. Recibe el archivo, ejecuta OCR/extracción y devuelve los datos
que luego se guardan vía `update_invoice_data`. → **Flujo 2 en Make** (con API de Claude visión).

### 2. URL firmada para ver el PDF
```
POST https://automate.smartautomation.cloud/webhook/get-signed-url-for-viewing
```
Devuelve una URL temporal para mostrar el PDF de la factura.
→ **No necesita Make ni n8n**: el SDK de Supabase (`storage.from("invoices").createSignedUrl(...)`)
lo hace directo desde el frontend. Se elimina esta dependencia.

## Flujos que NO están en el frontend (pero deben existir en el backend actual)

- **Sincronización BC → Supabase** (empresas, proveedores, órdenes). Es lo que llena las 798
  órdenes y los 32,957 proveedores. → **Flujo 1 en Make**.
- **Exportación de factura aprobada → Business Central**. Los mensajes de error del bundle lo
  confirman ("Tiempo de espera agotado en Business Central al crear la cabecera"). → **Flujo 3 en Make**.

## Integración ERP

Las facturas exportadas reciben un `erp_id` de Business Central y quedan monitoreadas en `/exports`.
Errores de exportación recuperables (estado `export_error`).
