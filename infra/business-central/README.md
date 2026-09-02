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
| `src/VendorPostingSetupAPI.al` | `vendorPostingSetups` — Gen. Bus./Vendor Posting Group, obligatorios para crear ordenes/facturas y no expuestos por la API estandar |
| `src/PurchInvoiceFiscalAPI.al` | `purchaseInvoiceFiscals` — "No. Comprobante Fiscal" (NCF) en facturas de compra sin publicar, obligatorio para postear y tampoco expuesto por la API estandar |
| `src/PurchInvoiceOrderLinkAPI.al` | `purchaseInvoiceOrderLinks` — "Order No."/"Order Line No." en lineas de factura de compra sin publicar, para que la orden de origen quede vinculada de verdad (seccion "Detalles Factura" de la orden) en vez de solo tener numeros parecidos. La API estandar marca `orderId` de solo lectura en la creacion y no expone estos campos en absoluto |
| `src/PurchOrderFiscalAPI.al` | `purchaseOrderFiscals` — lectura del "Expense Class Code" ya cargado en la orden de compra (lo pone quien arma la orden en BC, no el portal), y desde 2026-09-01 lectura+escritura de "Vendor Invoice No." y NCF (`DSNNo. Comprobante Fiscal`) — item 3/5 del pedido de Key Players, el portal deja esos 2 datos + la fecha (via el `orderDate` estandar) visibles en la orden misma, ademas de la factura separada que ya crea `bc-export-invoice` |

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
   `Adsm Purch Receipts API`, `Adsm Purch Receipt Lines API`,
   `Adsm Vendor Ledger Entr. API` y `Adsm Vendor Posting Setup API`, y
   **lectura + modificación** sobre `Adsm Purch Inv Fiscal API`,
   `Adsm Purch Inv Order Link API` y `Adsm Purch Order Fiscal API` (las 3 se
   usan para escribir desde 2026-09-01, la última dejó de ser solo lectura),
   asignado a la aplicación (`BC_CLIENT_ID`) que ya usa la integración — sin
   esto, las llamadas autenticadas con las credenciales actuales van a
   devolver 403 aunque la extensión esté instalada. Si el permission set ya
   existía de antes con `Adsm Purch Order Fiscal API` en modo solo-lectura,
   hay que editarlo para agregar Modify, no alcanza con re-publicar la
   extensión.

## Antes de dar esto por bueno

- **Verificar los nombres de campo contra el sandbox real.** Los nombres
  usados aquí (`"Buy-from Vendor No."`, `"Remaining Amount"`, etc.) son los
  estándar de la app base de BC y llevan años estables, pero **no se
  verificaron contra este tenant específico** — si Adsemble tiene
  personalizaciones sobre estas tablas, podrían no coincidir. `AL: Download
  Symbols` + el explorador de objetos de VS Code lo confirma en segundos.
- **Probar primero en `Test672026`**, nunca directo en `Production` — es
  el mismo sandbox que ya validó el resto de la integración.
- **`PurchInvoiceFiscalAPI.al` es el que más riesgo tiene de fallar al
  compilar.** El campo `"No. Comprobante Fiscal"` no es de la app base de
  BC — lo agrega una extensión de cumplimiento fiscal dominicano ya
  instalada en el tenant, y el nombre se tomó del caption visible en
  pantalla (confirmado por Jonatan con Ctrl+Alt+F1), no de los símbolos.
  Si el nombre interno real es distinto, `F5` va a fallar con un error de
  compilación tipo "The field 'No. Comprobante Fiscal' does not exist in
  Purchase Header" — en ese caso, el explorador de objetos de VS Code
  (`AL: Open Symbols` → tabla `Purchase Header`) sí va a mostrar el nombre
  correcto para corregirlo.
- **`PurchInvoiceOrderLinkAPI.al` es el segundo archivo con más riesgo de
  fallar al compilar**, aunque menor que el de arriba: `"Order No."` y
  `"Order Line No."` son campos estándar de la app base de Microsoft
  (existen en `Purchase Line` desde NAV), no de un ISV de cumplimiento
  fiscal — pero tampoco se verificaron todavía contra este tenant
  específico. Mismo procedimiento si `F5` falla: `AL: Open Symbols` →
  tabla `Purchase Line`.
- **`PurchOrderFiscalAPI.al` reutiliza campos ya verificados**: NCF
  (`"DSNCod. Clasificacion Gasto"` y `"DSNNo. Comprobante Fiscal"`, los
  mismos de `PurchInvoiceFiscalAPI.al`) sobre el mismo `Purchase Header`,
  solo que filtrado a `Document Type = Order` en vez de `Invoice` — riesgo
  de compilación bajo, ya se confirmó vía el `$metadata` legacy en vivo
  (2026-09-01, ver `docs/BITACORA.md`) que ambos existen. El campo nuevo
  `"Vendor Invoice No."` **sí es de la app base de Microsoft** (no de un
  ISV) — riesgo aún más bajo que los DSN, pero como toda esta lista,
  confirmar contra `AL: Open Symbols` → `Purchase Header` si `F5` falla.
- Una vez confirmado que responde bien en el sandbox, recién ahí publicar
  a `Production` siguiendo el mismo proceso.

## `app.json` apunta a UN solo entorno a la vez (2026-09-02)

`AL: Download Symbols` pide versiones **exactas** de `application` y de
las dependencias PTE (`Adsemble Liquid Base`, `DSLocalization`) — no
alcanza con "mayor o igual". El sandbox (`Test672026`) y `Production`
corren versiones distintas de BC y de esas mismas extensiones:

| Campo | Test672026 (sandbox) | Production |
|---|---|---|
| `application` | `27.5.0.0` | `28.4.0.0` |
| `dependencies` → `DSLocalization`.`version` | `1.1.2.65` | `1.1.2.66` |
| `dependencies` → `Adsemble Liquid Base`.`version` | `1.0.0.91` | `1.0.0.91` (igual en los dos) |

(Verificado en vivo contra `api/microsoft/automation/v2.0/.../extensions`
de cada entorno, no adivinado.)

**`app.json` en el repo queda apuntado al sandbox** (columna izquierda) —
ver "Publicar en Production sin conexión de desarrollo" abajo, el motivo.

## Publicar en Production: la conexión de desarrollo (F5 / Download
Symbols) está bloqueada, hay que compilar y subir el `.app` a mano (2026-09-02)

Con `app.json` ya apuntado a las versiones reales de Production
(`application: 28.4.0.0`, `DSLocalization: 1.1.2.66`), `AL: Download
Symbols` contra la configuración `Production` de `launch.json` siguió
fallando con `Internal Server Error` para los 4 paquetes de referencia
(`Application`, `System`, `Adsemble Liquid Base`, `DSLocalization`) —
tres intentos, incluido uno con `AL: Clear Credentials Cache` +
reautenticación completamente fresca, mismo resultado exacto los tres.
Esa consistencia (falla igual sin importar si la versión pedida es
correcta, y sin importar credenciales viejas vs. nuevas) apunta a que el
entorno **Production tiene deshabilitada la conexión de desarrollo
directa** (política común en tenants gestionados) — no a un permiso
puntual de un usuario ni a las versiones del `app.json`.

**Camino que sí funciona**, decidido con Jonatan: compilar la extensión
contra el **sandbox** (ahí `Download Symbols` y la compilación sí
funcionan, ya confirmado) y subir el `.app` resultante a Production a
mano — un método de instalación soportado y estándar de BC que no
necesita ninguna conexión de desarrollo activa contra Production:

1. `app.json` ya está de vuelta en los valores del sandbox (tabla de
   arriba, columna izquierda) — no hace falta tocarlo.
2. En VS Code, seleccioná la configuración **"Test672026 (Sandbox)"** de
   `launch.json`.
3. `Ctrl+Shift+P` → **AL: Download Symbols** (debería funcionar, ya se
   probó antes).
4. `Ctrl+Shift+P` → **AL: Package** — compila y genera el archivo
   `.app` en `infra/business-central/` (o la carpeta de salida
   configurada), **sin** publicarlo ni depurar contra ningún entorno.
5. En Business Central, entrá a **Production** → **Extension
   Management** → **Upload Extension** → seleccioná ese `.app` →
   seguí el asistente de instalación.
6. Una vez instalada: mismo paso de siempre, crear/ampliar el
   permission set en Production con los mismos permisos ya otorgados en
   el sandbox, asignado al `BC_CLIENT_ID` de la integración.

El `.app` compilado contra el sandbox (`Application 27.5.x`,
`DSLocalization 1.1.2.65`) instala sin problema en Production
(`28.4.x`, `1.1.2.66`) porque son versiones **más nuevas** — BC acepta
instalar una extensión sobre dependencias iguales o más nuevas que las
que declara, el problema era específicamente el paso de compilación en
vivo contra Production, no la compatibilidad real del código.

## Después de publicar: cablear el cliente (si hace falta)

`infra/supabase/functions/_shared/bc-client.ts` ya soporta un segundo
prefijo de API (`api: "custom"`) para las Custom API pages de esta
extensión, bajo:

```
/api/adsemble/vendorPortal/v1.0/companies({id})/...
```

`bc-export-invoice` ya llama `purchaseInvoiceFiscals` (NCF + Expense Class
Code) y `purchaseInvoiceOrderLinks` (vínculo con la orden) por ese prefijo;
`bc-sync-orders` ya llama `purchaseOrderFiscals` (lectura del Expense Class
Code de la orden) — no hace falta tocar el cliente para ninguno de estos.
`purchaseReceipts` y `vendorLedgerEntries` (solo lectura) están publicados
pero **todavía no tienen ningún caller** del lado del portal — son el
siguiente paso una vez se decida qué pantalla los va a mostrar (ver
`docs/BUSINESS_CENTRAL_INTEGRATION.md §7`).

**Después de publicar `PurchOrderFiscalAPI.al` específicamente:** hace
falta correr `bc-sync-orders` una vez (manual o esperar al próximo
schedule) para que las órdenes ya sincronizadas anteriormente traigan
`bc_expense_class_code` — no se retroalimenta solo con el publish de BC,
necesita ese sync.
