// Cliente minimo para Business Central API v2.0 (OAuth2 client-credentials).
// Credenciales via env (BC_TENANT_ID/BC_CLIENT_ID/BC_CLIENT_SECRET/BC_ENVIRONMENT),
// inyectadas al contenedor de Edge Functions desde
// supabase/docker-compose.override.yml -> supabase/.env (nunca versionadas).
// Validado en vivo contra el sandbox Test672026 — ver plan Fase A.
//
// Multiempresa (Fase 2, 2026-08-29): el tenant/credenciales de Azure AD son
// compartidos entre TODAS las empresas del entorno (confirmado en vivo: un
// solo token listo las 15 empresas y sus proveedores sin pedir nada
// distinto por empresa) -- lo unico que cambia entre empresas es el GUID
// que va en la URL (/companies(id)/...). Por eso BC_COMPANY_ID dejo de ser
// variable de entorno: cada funcion que llama a este cliente ahora pasa el
// GUID de la empresa (companies.bc_code en Supabase) como primer argumento
// de cada llamada, en vez de que el cliente lo lea fijo del proceso.

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cache: TokenCache | null = null;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

async function getAccessToken(): Promise<string> {
  if (cache && cache.expiresAt > Date.now() + 30_000) {
    return cache.accessToken;
  }

  const tenantId = requireEnv("BC_TENANT_ID");
  const clientId = requireEnv("BC_CLIENT_ID");
  const clientSecret = requireEnv("BC_CLIENT_SECRET");

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://api.businesscentral.dynamics.com/.default",
    }),
  });

  if (!res.ok) {
    throw new Error(`No se pudo obtener token de Azure AD: HTTP ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cache = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cache.accessToken;
}

// "standard" = API v2.0 de Microsoft (vendors, purchaseInvoices, ...).
// "custom" = la extension AL propia de Adsemble (infra/business-central/),
// publicada en Test672026 el 2026-08-20: purchaseReceipts y
// vendorLedgerEntries, que la API estandar no expone para este tenant.
type BcApi = "standard" | "custom";

function baseUrl(api: BcApi = "standard"): string {
  const tenantId = requireEnv("BC_TENANT_ID");
  const environment = requireEnv("BC_ENVIRONMENT");
  const apiPath = api === "custom" ? "api/adsemble/vendorPortal/v1.0" : "api/v2.0";
  return `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environment}/${apiPath}`;
}

function companyPath(companyId: string, path: string): string {
  if (!companyId) throw new Error("companyId vacio -- falta el GUID de la empresa en BC (companies.bc_code)");
  return `/companies(${companyId})${path}`;
}

async function bcFetch(path: string, api: BcApi = "standard", init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl(api)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export async function bcGet<T>(companyId: string, path: string, api: BcApi = "standard"): Promise<T> {
  const res = await bcFetch(companyPath(companyId, path), api);
  if (!res.ok) {
    throw new Error(`BC GET ${path} (empresa ${companyId}) -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Sigue @odata.nextLink hasta agotar las paginas — necesario porque BC pagina
// resultados por defecto (ej. purchaseOrders con muchas filas).
export async function bcGetAll<T>(companyId: string, path: string, api: BcApi = "standard"): Promise<T[]> {
  let url: string | null = `${baseUrl(api)}${companyPath(companyId, path)}`;
  const results: T[] = [];
  while (url) {
    const token = await getAccessToken();
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`BC GET ${url} -> HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { value: T[]; "@odata.nextLink"?: string };
    results.push(...data.value);
    url = data["@odata.nextLink"] ?? null;
  }
  return results;
}

export async function bcPost<T>(companyId: string, path: string, body: unknown, api: BcApi = "standard"): Promise<T> {
  const res = await bcFetch(companyPath(companyId, path), api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`BC POST ${path} (empresa ${companyId}) -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// If-Match: "*" evita tener que leer el @odata.etag actual antes de escribir
// (mismo truco que ya usa bcAttachFile) — aceptable aqui porque nunca hay
// escrituras concurrentes sobre la misma factura recien creada.
export async function bcPatch<T>(companyId: string, path: string, body: unknown, api: BcApi = "standard"): Promise<T> {
  const res = await bcFetch(companyPath(companyId, path), api, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "If-Match": "*" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`BC PATCH ${path} (empresa ${companyId}) -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// El adjunto se crea en dos pasos: registro (fileName) y luego el contenido
// binario via PATCH a la propiedad de streaming "attachmentContent" (nombre
// confirmado en sandbox via el mediaEditLink devuelto por el registro creado
// — la API v2.0 NO usa "/content" como en otras APIs OData de BC).
//
// OJO (2026-09-04): esta funcion usa /attachments, que en BC esta respaldado
// por "Incoming Document Attachment" (tabla 133) -- el mecanismo que resulto
// estar roto en este tenant (ver bcAttachDocumentFile abajo y
// .gstack/qa-reports/bc-support-cp229-attachments.md). YA NO LA USA NADIE
// para escribir; queda solo por si hace falta volver a diagnosticar ese
// camino. Para adjuntar de verdad, usar bcAttachDocumentFile.
export async function bcAttachFile(
  companyId: string,
  parentPath: string,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ id: string }> {
  const created = await bcPost<{ id: string }>(companyId, `${parentPath}/attachments`, { fileName });

  const res = await bcFetch(
    companyPath(companyId, `${parentPath}/attachments(${created.id})/attachmentContent`),
    "standard",
    {
      method: "PATCH",
      headers: { "Content-Type": contentType, "If-Match": "*" },
      body: bytes,
    },
  );
  if (!res.ok) {
    throw new Error(`BC attachment content PATCH -> HTTP ${res.status} ${await res.text()}`);
  }
  return created;
}

// === documentAttachments: el camino que SI funciona (2026-09-04) ===
//
// BC expone DOS mecanismos de adjuntos distintos sobre el mismo documento, y
// solo uno de los dos es confiable en este tenant:
//
//   1. /attachments  -> tabla "Incoming Document Attachment" (133). Pasa por
//      la maquinaria de Documentos Entrantes / Document Capture. Es el que
//      veniamos usando y el que se rompio: el POST de metadata devuelve 201,
//      el PATCH de contenido devuelve 204 la primera vez, y minutos despues
//      el adjunto desaparece del listado y CUALQUIER adjunto posterior sobre
//      esa misma orden falla con 404 "Resource not found for the segment
//      'attachment'". Reproducido en CP-000229 y CP-000232; falla tambien
//      dentro de la interfaz nativa de BC ("Error al intentar mostrar el
//      informe"), o sea que no es de nuestra integracion.
//
//   2. /documentAttachments -> tabla "Document Attachment" (1173), el
//      FactBox "Documentos adjuntos" de toda la vida. No toca Documentos
//      Entrantes en absoluto.
//
// Verificado en vivo (2026-09-04) contra las DOS ordenes rotas, con los PDF
// reales de las facturas que estaban trabadas: POST 201 -> PATCH contenido
// 204 -> GET de vuelta 200 con los bytes IDENTICOS al original (md5 igual,
// 131418 y 70202 bytes). Es decir, el mismo registro que rechazaba el
// mecanismo 1 acepta el mecanismo 2 sin problema.
//
// Nota: el listado de documentAttachments devuelve siempre byteSize 0 (BC no
// lo calcula en esa vista), asi que NO sirve para verificar que el contenido
// subio -- por eso bcAttachDocumentFile verifica leyendo el contenido de
// vuelta, ver abajo.
export interface BcDocumentAttachment {
  id: string;
  fileName: string;
  byteSize: number;
  parentId: string;
  lastModifiedDateTime: string;
}

export async function bcListDocumentAttachments(
  companyId: string,
  parentPath: string,
): Promise<BcDocumentAttachment[]> {
  const res = await bcGet<{ value: BcDocumentAttachment[] }>(companyId, `${parentPath}/documentAttachments`);
  return res.value;
}

export async function bcGetDocumentAttachmentContent(
  companyId: string,
  parentPath: string,
  attachmentId: string,
): Promise<Response> {
  const res = await bcFetch(
    companyPath(companyId, `${parentPath}/documentAttachments(${attachmentId})/attachmentContent`),
    "standard",
  );
  if (!res.ok) {
    throw new Error(`BC GET documentAttachment content -> HTTP ${res.status} ${await res.text()}`);
  }
  return res;
}

// Adjunta un archivo a un documento de BC y NO devuelve exito hasta haber
// leido el contenido de vuelta y confirmado que el tamaño coincide.
//
// Esa verificacion no es paranoia: el bug que nos costo dias fue exactamente
// que BC devolvia 204 (exito) en el PATCH y el archivo despues no estaba. El
// portal marcaba la factura "Exportada" y el equipo de Adsemble asumia que el
// PDF estaba en la orden cuando no lo estaba. Preferimos un export_error
// honesto y reintentable antes que un "exito" que miente.
export async function bcAttachDocumentFile(
  companyId: string,
  parentPath: string,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ id: string; verifiedBytes: number }> {
  const created = await bcPost<{ id: string }>(companyId, `${parentPath}/documentAttachments`, {
    fileName,
    parentType: "Purchase Order",
  });

  const res = await bcFetch(
    companyPath(companyId, `${parentPath}/documentAttachments(${created.id})/attachmentContent`),
    "standard",
    {
      method: "PATCH",
      headers: { "Content-Type": contentType, "If-Match": "*" },
      body: bytes,
    },
  );
  if (!res.ok) {
    throw new Error(`BC documentAttachment content PATCH -> HTTP ${res.status} ${await res.text()}`);
  }

  const readBack = await bcGetDocumentAttachmentContent(companyId, parentPath, created.id);
  const verifiedBytes = (await readBack.arrayBuffer()).byteLength;
  if (verifiedBytes !== bytes.byteLength) {
    throw new Error(
      `BC acepto el adjunto pero al leerlo de vuelta no coincide: subimos ${bytes.byteLength} bytes y BC devolvio ${verifiedBytes}. No se marca como exportada.`,
    );
  }

  return { id: created.id, verifiedBytes };
}

// Lectura de adjuntos (Key Players, 2026-09-01, item 5) -- /attachments es
// un sub-recurso de la API ESTANDAR v2.0 (confirmado en vivo contra
// purchaseOrders, no hace falta ninguna extension AL para esto, a
// diferencia de purchaseOrderFiscals). Sirve igual para cualquier
// documento que soporte adjuntos (purchaseOrders, purchaseInvoices, etc.),
// no solo ordenes.
export interface BcAttachment {
  id: string;
  fileName: string;
  byteSize: number;
  documentId: string;
  lastModifiedDateTime: string;
}

export async function bcListAttachments(companyId: string, parentPath: string): Promise<BcAttachment[]> {
  const res = await bcGet<{ value: BcAttachment[] }>(companyId, `${parentPath}/attachments`);
  return res.value;
}

// Devuelve el Response crudo (sin parsear) -- attachmentContent es una
// propiedad de streaming, el binario viaja tal cual con su Content-Type
// real, no como JSON. Quien llama decide si lo reenvia directo (proxy) o
// lo lee a bytes.
export async function bcGetAttachmentContent(companyId: string, parentPath: string, attachmentId: string): Promise<Response> {
  const res = await bcFetch(
    companyPath(companyId, `${parentPath}/attachments(${attachmentId})/attachmentContent`),
    "standard",
  );
  if (!res.ok) {
    throw new Error(`BC GET attachment content -> HTTP ${res.status} ${await res.text()}`);
  }
  return res;
}
