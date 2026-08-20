// Cliente minimo para Business Central API v2.0 (OAuth2 client-credentials).
// Credenciales via env (BC_TENANT_ID/BC_CLIENT_ID/BC_CLIENT_SECRET/BC_ENVIRONMENT/
// BC_COMPANY_ID), inyectadas al contenedor de Edge Functions desde
// supabase/docker-compose.override.yml -> supabase/.env (nunca versionadas).
// Validado en vivo contra el sandbox Test672026 — ver plan Fase A.

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

function baseUrl(): string {
  const tenantId = requireEnv("BC_TENANT_ID");
  const environment = requireEnv("BC_ENVIRONMENT");
  return `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environment}/api/v2.0`;
}

function companyPath(path: string): string {
  const companyId = requireEnv("BC_COMPANY_ID");
  return `/companies(${companyId})${path}`;
}

async function bcFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export async function bcGet<T>(path: string): Promise<T> {
  const res = await bcFetch(companyPath(path));
  if (!res.ok) {
    throw new Error(`BC GET ${path} -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Sigue @odata.nextLink hasta agotar las paginas — necesario porque BC pagina
// resultados por defecto (ej. purchaseOrders con muchas filas).
export async function bcGetAll<T>(path: string): Promise<T[]> {
  let url: string | null = `${baseUrl()}${companyPath(path)}`;
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

export async function bcPost<T>(path: string, body: unknown): Promise<T> {
  const res = await bcFetch(companyPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`BC POST ${path} -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// El adjunto se crea en dos pasos: registro (fileName) y luego el contenido
// binario via PATCH a la propiedad de streaming "attachmentContent" (nombre
// confirmado en sandbox via el mediaEditLink devuelto por el registro creado
// — la API v2.0 NO usa "/content" como en otras APIs OData de BC).
export async function bcAttachFile(
  parentPath: string,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ id: string }> {
  const created = await bcPost<{ id: string }>(`${parentPath}/attachments`, { fileName });

  const res = await bcFetch(companyPath(`${parentPath}/attachments(${created.id})/attachmentContent`), {
    method: "PATCH",
    headers: { "Content-Type": contentType, "If-Match": "*" },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`BC attachment content PATCH -> HTTP ${res.status} ${await res.text()}`);
  }
  return created;
}
