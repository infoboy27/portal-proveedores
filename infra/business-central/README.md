# Extensión AL — Custom API pages para el Vendor Portal

Cierra los dos bloqueos reales de integración con Business Central que
quedan (ver `docs/BUSINESS_CENTRAL_INTEGRATION.md §4` y `docs/BITACORA.md`):
la API v2.0 estándar no expone **recepciones de compra** ni **movimientos
de cuentas por pagar** para este tenant. Ambas son necesarias, solo
lectura, y no reemplazan nada de lo que ya funciona (órdenes de compra y
export de facturas siguen usando la API estándar sin cambios).

| Archivo | Expone |
|---|---|
| `src/PurchReceiptsAPI.al` | `purchaseReceipts` / `purchaseReceiptLines` — recepciones publicadas contra una orden de compra |
| `src/VendorLedgerEntriesAPI.al` | `vendorLedgerEntries` — movimientos de cuentas por pagar (pagos, saldo) |

## Ya está instalado y preconfigurado (2026-08-20)

- **VS Code** ya estaba instalado en la máquina de Jonatan.
- Extensión **"AL Language"** de Microsoft — instalada.
- `.vscode/launch.json` — ya apunta al sandbox `Test672026` con el mismo
  `tenant` (`BC_TENANT_ID`) que usa el resto de la integración en
  `supabase/.env`.

Lo único que falta y **no se puede automatizar** es el login: publicar
requiere iniciar sesión con una cuenta de Microsoft que tenga permisos de
desarrollo en ese entorno — es un paso interactivo (con MFA), tiene que
hacerlo la persona dueña de esa cuenta.

## Lo que falta de tu lado

1. Un usuario de Business Central con **permisos de desarrollo** en el
   entorno sandbox (`Test672026`) — es un permiso distinto al acceso al
   Admin Center que ya tienes. Se otorga vía un permission set que incluya
   `D365 EXTENSION MGT` (o `SUPER` en sandbox, nunca en producción). Si
   `w.deschamps@adsemble.do` no lo tiene todavía, alguien con rol de
   administrador en BC se lo asigna desde **Business Central → Usuarios**.
2. Iniciar sesión cuando VS Code lo pida (paso 3 abajo).

## Pasos para publicar en el sandbox

1. La carpeta `infra/business-central/` ya está abierta en VS Code.
2. `Ctrl+Shift+P` → **AL: Download Symbols** — pedirá iniciar sesión con
   la cuenta de Microsoft de BC (aquí es donde entra tu MFA). Esto trae
   las definiciones reales de las tablas estándar de BC para el entorno.
3. Revisar `app.json`: el campo `"application"` debe coincidir con la
   versión real del entorno (el Admin Center la muestra — a la fecha de
   este documento el entorno mostraba versión ~28.x). Ajustar si no
   coincide.
4. `F5` (o `Ctrl+F5` para publicar sin depurar) — VS Code compila y
   publica la extensión al sandbox.
5. En el sandbox, **Business Central → Extension Management**, confirmar
   que "Adsemble Vendor Portal API Extensions" aparece instalada.
6. Crear (o ampliar) un **permission set** que incluya lectura sobre
   `Adsm Purch Receipts API`, `Adsm Purch Receipt Lines API`, y
   `Adsm Vendor Ledger Entr. API`, y asignarlo a la aplicación
   (`BC_CLIENT_ID`) que ya usa la integración — sin esto, las llamadas
   autenticadas con las credenciales actuales van a devolver 403 aunque la
   extensión esté instalada.

## Antes de dar esto por bueno

- **Verificar los nombres de campo contra el sandbox real.** Los nombres
  usados aquí (`"Buy-from Vendor No."`, `"Remaining Amount"`, etc.) son los
  estándar de la app base de BC y llevan años estables, pero **no se
  verificaron contra este tenant específico** — si Adsemble tiene
  personalizaciones sobre estas tablas, podrían no coincidir. `AL: Download
  Symbols` + el explorador de objetos de VS Code lo confirma en segundos.
- **Probar primero en `Test672026`**, nunca directo en `Production` — es
  el mismo sandbox que ya validó el resto de la integración.
- Una vez confirmado que responde bien en el sandbox, recién ahí publicar
  a `Production` siguiendo el mismo proceso.

## Después de publicar: falta cablear el cliente

`infra/supabase/functions/_shared/bc-client.ts` hoy arma las URLs contra
`/api/v2.0` (la API estándar). Las Custom API pages viven bajo un prefijo
distinto:

```
/api/adsemble/vendorPortal/v1.0/companies({id})/purchaseReceipts
/api/adsemble/vendorPortal/v1.0/companies({id})/vendorLedgerEntries
```

`bc-client.ts` necesita un `baseUrl` alternativo (o un parámetro) para
apuntar a este prefijo en vez de `/api/v2.0` — no se tocó todavía porque no
tiene sentido cablearlo antes de que la extensión esté publicada y
probada. Es el siguiente paso una vez confirmes que la extensión
responde en el sandbox.
