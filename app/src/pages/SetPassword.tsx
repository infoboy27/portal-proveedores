import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import logoAdsemble from "@/assets/logo-adsemble.jpg";

// Landing del enlace de invitacion/recuperacion (invite-user Edge Function
// manda redirectTo=/set-password; la plantilla de correo tiene la marca de
// Adsemble, ver infra/supabase/auth-templates/). Supabase ya establece la
// sesion desde el hash de la URL automaticamente -- esta pantalla solo pide
// la contrasena nueva, que es como se completa el "primer login" del
// proveedor/usuario invitado.
export function SetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setReady(!!data.session));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    navigate("/");
  }

  if (ready === null) return null;

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <img src={logoAdsemble} alt="Adsemble" className="mx-auto mb-6 h-14 w-auto" />
          <p className="text-sm text-slate-600">
            Este enlace ya no es válido o expiró. Pide un nuevo enlace de invitación o recuperación de contraseña.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md p-8">
        <img src={logoAdsemble} alt="Adsemble" className="mx-auto mb-6 h-14 w-auto" />
        <h1 className="text-2xl font-semibold text-slate-950">Crea tu contraseña</h1>
        <p className="mt-1 text-sm text-slate-600">Esta será tu contraseña para entrar al Portal de Proveedores.</p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <Input
            type="password"
            placeholder="Nueva contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="Confirmar contraseña"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Guardando..." : "Guardar y entrar"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
