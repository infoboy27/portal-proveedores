import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import logoAdsemble from "@/assets/logo-adsemble.jpg";

export function Login() {
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Pedido 2026-08-20: los proveedores pueden entrar con su correo, o con
    // el RNC/cedula registrado en BC. Supabase Auth solo hace login por
    // correo, asi que si lo que se escribio no parece un correo, se resuelve
    // primero via resolve-login-identifier (RNC/cedula -> correo real).
    let loginEmail = identifier.trim();
    if (!loginEmail.includes("@")) {
      const { data, error: resolveErr } = await supabase.functions.invoke("resolve-login-identifier", {
        body: { identifier: loginEmail },
      });
      if (resolveErr || !data?.ok) {
        setLoading(false);
        setError(data?.error ?? "No se encontró una cuenta con ese usuario, RNC o cédula.");
        return;
      }
      loginEmail = data.email as string;
    }

    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    navigate("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md p-8">
        <img src={logoAdsemble} alt="Adsemble" className="mx-auto mb-6 h-14 w-auto" />
        <h1 className="text-2xl font-semibold text-slate-950">Portal Proveedores Adsemble</h1>
        <p className="mt-1 text-sm text-slate-600">Inicia sesión con tu correo, RNC o cédula</p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <Input
            placeholder="Correo, RNC o cédula"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Ingresando..." : "Ingresar"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
