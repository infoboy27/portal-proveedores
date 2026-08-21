# Guía de prueba manual — ciclo completo del Portal de Proveedores

Esta guía te deja probar tú mismo, de principio a fin, exactamente el mismo
ciclo que ya se probó y funciona: crear una orden en Business Central,
verla llegar al portal, confirmarla y facturarla como si fueras el
proveedor, aprobarla y exportarla como si fueras Adsemble, postearla en BC,
y ver el pago reflejado de vuelta en el portal.

Vas a jugar dos roles con dos sesiones distintas del portal — anota esto
porque **abrir una sesión nueva en una pestaña reemplaza la sesión de las
demás pestañas del mismo navegador** (es como funciona el login, no es un
error). Lo más simple es usar dos navegadores distintos (ej. Chrome para
admin, Firefox/Edge para proveedor), o cerrar sesión y volver a entrar
entre cada parte.

## Accesos que vas a necesitar

**Business Central** — sandbox `Test672026`, con tu usuario de siempre.

**Portal como administrador (tú, Adsemble)**
- URL: https://proveedores.jfmcss.com
- Usuario: `jonathanmaria@gmail.com`
- Tu contraseña de siempre.

**Portal como proveedor (cuenta de prueba, ya creada y lista)**
- Usuario: `jonathanmaria+qa2026@gmail.com`
- Contraseña: `QaTest2026!Adsemble`
- Está mapeada al proveedor **JONATAN FRANCISCO MARIA CASTRO (PROV-000278)**
  en el sandbox — es tu propio proveedor de prueba, no uno real de un
  tercero.

## Antes de empezar: por qué usar la cuenta `6107 - Servicios`

Para que la prueba fluya sin tropezar con datos de BC sin configurar, usa
la cuenta contable **`6107 - Servicios`** en la línea de tu orden de
compra. Ya está corregida con sus grupos de contabilización/IVA correctos
(servicio gravado al 18%). Si usas otra cuenta que nunca se ha usado antes,
es posible que te tropieces con el mismo tipo de bloqueo que resolvimos
para esta ("VAT Prod. Posting Group must have value...") — no es un error
del portal, es un dato de BC que faltaría configurar en esa cuenta
específica.

---

## Parte 1 — Crear la orden de compra en Business Central

El portal no tiene botón para crear órdenes — nacen en BC, igual que hoy.

1. Entra a Business Central, sandbox `Test672026`.
2. Busca **"Pedidos de compra"** (Purchase Orders) → **Nuevo**.
3. **Proveedor**: `PROV-000278` (Jonatan Francisco Maria Castro).
4. En las líneas:
   - **Tipo**: Cuenta (G/L Account)
   - **Número**: `6107`
   - **Descripción**: lo que quieras (ej. "Prueba manual del ciclo completo")
   - **Cantidad**: `1`
   - **Costo unitario directo**: el monto que quieras, ej. `5000`
5. Guarda. Anota el número de orden (`CP-0XXXXX`).
6. **Libera la orden** (botón "Lanzar" / "Release", o `F9`) — obligatorio.
   El portal ya no trae órdenes en estado Borrador (Draft) — solo las que
   Adsemble ya liberó/aprobó internamente en BC. Mientras esté en
   Borrador no va a aparecer para el proveedor ni para el admin, a
   propósito.

## Parte 2 — Esperar (o no) la sincronización

La orden llega sola al portal cada **15 minutos** (cron automático), pero
solo después de liberada (paso 6). Si no
quieres esperar, avísame el número de orden y la sincronizo manual en
segundos.

## Parte 3 — Verla como administrador en el portal

1. Entra a https://proveedores.jfmcss.com con tu cuenta de superadmin.
2. Ve a **"Ordenes de compra"**, busca tu número de orden.
3. Confirma que aparece con el proveedor y el monto correctos.

(Esto es exactamente lo que Adsemble ve — cualquier orden real de
cualquier proveedor real se ve igual acá.)

## Parte 4 — Confirmarla como proveedor

1. Cierra sesión (o abre otro navegador) y entra con
   `jonathanmaria+qa2026@gmail.com`.
2. Nota cómo el menú cambia — ya no ves "Users", "Suppliers", "Seguridad",
   solo lo que un proveedor real vería: Ordenes, Invoices, Pagos.
3. Ve a **"Ordenes de compra"**, abre la tuya.
4. Click **"Confirmar orden"**.

## Parte 5 — Subir la factura (con lectura automática)

Sigues como proveedor, en la misma orden.

1. Click **"Subir factura"**.
2. Sube un PDF. Para que la lectura automática (OCR) funcione, el PDF
   necesita tener texto real (no solo una foto/escaneo borroso) con líneas
   como:
   ```
   NCF: E310000000001
   Fecha: 20/08/2026
   ```
   Puede ser una factura real que tengas a mano, o un PDF simple armado a
   propósito con esos datos.
3. Espera unos segundos (el OCR corre solo, en el servidor). Al abrir la
   factura subida, **NCF y fecha deberían aparecer ya llenos** — no hace
   falta escribirlos a mano.

Si el OCR no encuentra nada (PDF sin esas etiquetas, o una foto muy
borrosa), no pasa nada — el formulario sigue siendo editable a mano,
igual que antes.

## Parte 6 — Completar y confirmar los datos

1. Revisa/completa lo que falte: **Número de factura**, **Total** (debe
   coincidir con el monto de la orden).
2. Click **"Confirmar datos"** — la factura pasa a estado
   `pending_approval`.

## Parte 7 — Aprobarla como administrador

1. Vuelve a entrar (u otra pestaña) con tu cuenta de superadmin.
2. Ve a **"Aprobaciones pendientes"**.
3. Debería aparecer tu factura — click **"Aprobar"**.

## Parte 8 — Exportarla a Business Central

1. Ve a **"Monitoreo de exportaciones"**.
2. Tu factura debería aparecer con estado `approved` y un botón
   **"Exportar ahora"** — haz click.
3. Espera unos segundos. Debería pasar a `processed` con un **ERP ID**
   real (`CF-0XXXXX`) — esa es la factura recién creada en BC, con el NCF
   y las líneas correctas, lista para revisión.

## Parte 9 — Postear en Business Central (todavía manual, a propósito)

El portal crea la factura en BC como **borrador** — postearla sigue siendo
una decisión de Adsemble, tomada dentro de BC, no algo que el portal haga
solo. Dos motivos:

- **Fecha de posteo**: BC solo permite postear dentro de un rango de
  fechas permitido — puede que tengas que ajustar la fecha de posteo de la
  factura en BC si la fecha de hoy cae fuera de ese rango en el sandbox.
- **"Expense Class Code"** (clasificación de gasto para los reportes
  606/607/608 de la DGII): el portal **no lo llena solo a propósito** — es
  una decisión contable tuya (qué código corresponde a qué tipo de gasto),
  no algo que el sistema deba adivinar y arriesgarse a reportar mal a
  Impuestos. Vas a tener que completarlo a mano en BC antes de postear.

Pasos en BC:
1. Busca **"Facturas de compra"** (Purchase Invoices), abre la que acabas
   de exportar (`CF-0XXXXX`).
2. Revisa NCF y Total — deberían venir correctos ya.
3. Completa **"Cod. Clasificación Gasto"** (o el campo equivalente que
   veas — puede estar en "Más opciones" / campos adicionales).
4. Postea (el botón de "Contabilizar"/"Post", o `Ctrl+F9`).

Si BC te pide algún otro dato obligatorio que no esperabas, probablemente
sea otro campo de datos maestro sin configurar (como pasó con la cuenta
`6107` o el método de pago del proveedor) — mándame el mensaje de error
exacto y lo resolvemos igual que los anteriores.

## Parte 10 — Ver el pago reflejado en el portal

Una vez posteada en BC, el sync de pagos corre cada **30 minutos** y trae
el estado real. Después de eso, entra a **"Pagos"** (con cualquiera de las
dos cuentas) y deberías ver tu factura con:
- **Origen**: Business Central
- **Fecha posible de pago**: la fecha real de BC
- **Estado**: "Pendiente de pago" (queda así hasta que alguien registre el
  pago real en BC — postear la factura la deja como una cuenta por pagar
  abierta, no como ya pagada)

Si no quieres esperar los 30 minutos, avísame y corro el sync manual.

---

## Resumen visual del ciclo

```
Business Central                    Portal de Proveedores
─────────────────                   ──────────────────────
Crear orden (Purchase Order)
        │
        │  (sync automático, 15 min)
        ▼
                                     Admin ve la orden
                                     Proveedor confirma la orden
                                     Proveedor sube factura (OCR lee NCF+fecha)
                                     Proveedor confirma datos
                                     Admin aprueba
                                     Admin exporta a BC
        ▲
        │
Factura creada como borrador (CF-0XXXXX)
Adsemble completa Cod. Clasificación Gasto
Adsemble postea (Ctrl+F9)
        │
        │  (sync automático, 30 min)
        ▼
                                     Pagos: aparece "Origen: Business Central"
```
