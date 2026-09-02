Asunto: Portal de Proveedores — actualización de avance

Hola Carolina,

Les comparto el avance del Portal de Proveedores. La buena noticia es que
esta semana terminamos de cerrar el ciclo completo: desde que se crea una
orden de compra en Business Central hasta que el proveedor la confirma,
sube su factura, nosotros la aprobamos, se exporta a BC, se contabiliza
ahí, y el estado del pago vuelve a reflejarse en el portal. Lo probamos de
punta a punta con datos reales, no solo en teoría.

**Lo que ya está construido y funcionando:**

- Acceso e invitación de usuarios: cada proveedor recibe un correo con la
  marca de Adsemble, crea su contraseña, y puede entrar con su correo,
  RNC o cédula.
- Roles y permisos separados por proveedor — cada uno solo ve sus propias
  órdenes, facturas y pagos.
- Sincronización automática con Business Central: órdenes de compra y
  recepciones cada 15 minutos, pagos cada 30 minutos, proveedores cada 6
  horas.
- El proveedor confirma sus órdenes de compra directamente en el portal.
- Carga de facturas con lectura automática del NCF y la fecha desde el
  PDF (sin costo por factura, corre en nuestro propio servidor) — el
  proveedor solo confirma los datos, no los escribe a mano.
- Validación automática: factura duplicada, monto contra la orden.
- Flujo de aprobación interno antes de exportar a Business Central.
- Exportación a Business Central respetando los requisitos fiscales
  dominicanos (NCF y clasificación de gasto para los reportes de la
  DGII) — esto nos tomó un poco más de tiempo porque esos campos no
  vienen expuestos de forma estándar en BC, hubo que construir una
  extensión puntual para poder escribirlos.
- Contabilización en BC y reflejo del estado de pago de vuelta en el
  portal — confirmado con una prueba real esta semana.
- Un rol de superadministrador con panel de auditoría (quién invitó,
  cambió o desactivó a quién, y cuándo se logueó cada usuario).

**Lo que falta, y lo que necesitamos de su lado para cerrar:**

1. **Un proveedor real para UAT.** Todo lo anterior está probado con un
   proveedor de prueba nuestro — para la validación final necesitamos que
   nos faciliten acceso a un proveedor real dispuesto a probar el flujo
   completo.
2. **Decisión de dominio**: `portalproveedores.adsemble.do` vs seguir en
   `proveedores.jfmcss.com`. En cuanto lo definan, hacemos el corte.
3. **Cuándo activar las invitaciones a los proveedores reales que ya
   existen en BC.** Por seguridad, el sistema no invita a nadie de forma
   automática — necesitamos su visto bueno para activar esto, y
   probablemente convenga hacerlo por lotes pequeños en vez de todos de
   una vez.

**Fuera de alcance de este proyecto** (para que quede explícito, no es un
olvido): un estado de cuenta completo con saldo histórico y notas de
crédito — lo que está construido es consulta de pago por factura
individual, que es lo que se acordó originalmente.

Quedamos atentos a sus comentarios y a coordinar el UAT en cuanto tengan
el proveedor de prueba disponible.

Saludos,
Jonatan
