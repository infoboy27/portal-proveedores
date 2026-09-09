import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { supabase } from "@/lib/supabase";
import type { Supplier } from "@/store/types";

// Reconstruccion de `function zP()` — index-beautified.js:29713.
//
// Key Players (2026-09-01, item 7 -- performance): esta es la UNICA
// pantalla que necesita navegar/buscar TODOS los proveedores (hoy 10.441)
// -- por eso pide su propia lista aparte (fetchAllSuppliers), en vez de
// depender del slice `suppliers` del store global, que ahora solo trae los
// vendors referenciados por invoices/ordenes ya cargadas (ver domain.ts).
// Se pide UNA vez al entrar a esta pantalla, no despues de cada mutacion
// de toda la app como pasaba antes.
export function Suppliers() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const fetchAllSuppliers = useDomainStore((s) => s.fetchAllSuppliers);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadingSuppliers(true);
    setLoadError(null);
    fetchAllSuppliers()
      .then((rows) => {
        if (!cancelled) setSuppliers(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "No se pudo cargar el listado de proveedores.");
      })
      .finally(() => {
        if (!cancelled) setLoadingSuppliers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAllSuppliers]);

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const scoped = useMemo(() => (isAdmin ? suppliers : suppliers), [isAdmin, suppliers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped.filter(
      (s) =>
        query.length === 0 ||
        s.displayName.toLowerCase().includes(query) ||
        s.vendorNumber.toLowerCase().includes(query) ||
        (s.email ?? "").toLowerCase().includes(query),
    );
  }, [scoped, search]);

  const stats = [
    { label: t("totalSuppliers"), value: scoped.length.toLocaleString() },
    { label: t("activeSuppliers"), value: scoped.filter((s) => !s.blocked).length.toLocaleString() },
    { label: t("blockedSuppliers"), value: scoped.filter((s) => s.blocked).length.toLocaleString() },
    { label: t("suppliersWithEmail"), value: scoped.filter((s) => !!s.email?.trim()).length.toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("suppliersListTitle")}</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("suppliersListDescription")}</p>
      </section>

      {isAdmin && <InternalVendorsCard />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} className="rounded-[24px] border border-white/70 bg-white/90 p-5 shadow-[0_18px_55px_rgba(15,23,42,0.06)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{stat.label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4 sm:p-5">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchSuppliersPlaceholder")} />
        {loadError && <p className="mt-2 text-sm text-rose-600">{loadError}</p>}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">{t("supplier")}</th>
                <th className="px-6 py-4">{t("email")}</th>
                <th className="px-6 py-4">{t("taxId")}</th>
                <th className="px-6 py-4">{t("status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loadingSuppliers ? (
                <tr>
                  <td colSpan={4} className="px-6 py-14 text-center text-sm text-slate-500">
                    Cargando proveedores...
                  </td>
                </tr>
              ) : filtered.length > 0 ? (
                filtered.map((s) => (
                  <tr key={s.id} className="transition hover:bg-slate-50/80">
                    <td className="px-6 py-4">
                      <p className="max-w-[560px] truncate text-sm font-semibold text-slate-950" title={s.displayName}>
                        {s.displayName}
                      </p>
                      <p className="text-xs text-slate-500">{s.vendorNumber}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{s.email ?? "-"}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{s.taxRegistrationNumber}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                          s.blocked ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {t(s.blocked ? "inactive" : "active")}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-6 py-14 text-center text-sm text-slate-500">
                    {t("noPurchaseOrdersFoundDescription")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// Administracion de la lista de proveedores internos fijos (2026-09-08,
// schema-v42.sql). Son los que factura Adsemble todos los meses y que el
// equipo registra desde el portal: aparecen en un desplegable corto al
// cargar una factura, para no buscarlos entre 3,609 cada vez.
//
// La lista guarda NUMEROS de proveedor, no filas de `vendors`: cada
// proveedor existe una vez por empresa, y asi la lista aplica a las siete.
// Por eso tambien sobrevive a las sincronizaciones desde BC.
function InternalVendorsCard() {
  const [rows, setRows] = useState<{ vendor_number: string; display_name: string; default_account: string | null }[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ vendor_number: string; company_name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data, error: err } = await supabase
      .from("internal_vendors")
      .select("vendor_number, display_name, default_account")
      .order("display_name");
    if (err) setError(err.message);
    else setRows((data as typeof rows) ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      // distinct por numero: el mismo proveedor aparece una vez por empresa.
      const { data } = await supabase
        .from("vendors")
        .select("vendor_number, company_name")
        .or(`company_name.ilike.%${term}%,vendor_number.ilike.%${term}%`)
        .limit(40);
      if (cancelled) return;
      const seen = new Set<string>();
      const unique = ((data as typeof results) ?? []).filter((v) =>
        seen.has(v.vendor_number) ? false : (seen.add(v.vendor_number), true),
      );
      setResults(unique.slice(0, 10));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  async function add(vendorNumber: string, displayName: string) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("internal_vendors")
      .upsert({ vendor_number: vendorNumber, display_name: displayName }, { onConflict: "vendor_number" });
    if (err) setError(err.message);
    setQuery("");
    setResults([]);
    await load();
    setBusy(false);
  }

  async function remove(vendorNumber: string) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from("internal_vendors").delete().eq("vendor_number", vendorNumber);
    if (err) setError(err.message);
    await load();
    setBusy(false);
  }

  async function saveAccount(vendorNumber: string, account: string) {
    const { error: err } = await supabase
      .from("internal_vendors")
      .update({ default_account: account.trim() || null })
      .eq("vendor_number", vendorNumber);
    if (err) setError(err.message);
    await load();
  }

  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold text-slate-950">Proveedores internos fijos</h2>
      <p className="mt-1 text-sm text-slate-600">
        Los que factura Adsemble todos los meses y registra el equipo desde el portal. Aparecen en un desplegable al
        cargar una factura. Aplica a las siete empresas.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="py-2">Proveedor</th>
              <th className="py-2">Número</th>
              <th className="py-2">Cuenta contable fija</th>
              <th className="py-2 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.vendor_number}>
                <td className="py-2 font-medium text-slate-900">{r.display_name}</td>
                <td className="py-2 text-slate-600">{r.vendor_number}</td>
                <td className="py-2">
                  <Input
                    defaultValue={r.default_account ?? ""}
                    placeholder="opcional"
                    className="w-32"
                    onBlur={(e) => void saveAccount(r.vendor_number, e.target.value)}
                  />
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    className="text-sm text-rose-600 underline"
                    onClick={() => void remove(r.vendor_number)}
                    disabled={busy}
                  >
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-500">
                  Todavía no hay proveedores internos definidos.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="relative mt-4 sm:w-96">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Agregar: buscar por nombre o número..." />
        {query.trim().length >= 3 && results.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
            {results.map((v) => (
              <button
                key={v.vendor_number}
                type="button"
                onClick={() => void add(v.vendor_number, v.company_name)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">{v.company_name}</span>{" "}
                <span className="text-slate-500">{v.vendor_number}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="mt-2 text-xs text-slate-500">
        La cuenta contable fija es opcional. Si se deja vacía, el portal la deduce del historial del proveedor en
        Business Central; póngala solo cuando ese historial no sea consistente.
      </p>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </Card>
  );
}
