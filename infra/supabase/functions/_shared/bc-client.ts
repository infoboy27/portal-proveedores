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
