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
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);

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

  // El reset de password para un usuario ya logueado lo hace un admin desde
  // Users.tsx (reset-user-password Edge Function). Esto es lo que faltaba:
  // el camino de autoservicio para alguien que todavia NO puede entrar.
  // resetPasswordForEmail es publico (no requiere sesion) y manda el mismo
  // correo real con la plantilla de marca -- el enlace aterriza en
  // /set-password, que ya funciona para invitaciones y recuperacion por
  // igual (Supabase arma la sesion sola desde el hash de la URL).
  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    setForgotMessage(null);
    const email = identifier.trim();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/set-password`,
    });
    setForgotLoading(false);
    // Mensaje generico a proposito -- no revela si el correo existe o no.
    setForgotMessage("Si ese correo tiene una cuenta, te enviamos un enlace para restablecer tu contraseña.");
  }

  if (forgotMode) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-md p-8">
          <img src={logoAdsemble} alt="Adsemble" className="mx-auto mb-6 h-14 w-auto" />
          <h1 className="text-2xl font-semibold text-slate-950">Recuperar contraseña</h1>
          <p className="mt-1 text-sm text-slate-600">Escribe tu correo y te mandamos un enlace para restablecerla.</p>
          <form className="mt-6 space-y-4" onSubmit={handleForgotPassword}>
            <Input
              type="email"
              placeholder="Correo"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            {forgotMessage && <p className="text-sm text-emerald-700">{forgotMessage}</p>}
            <Button type="submit" className="w-full" disabled={forgotLoading}>
              {forgotLoading ? "Enviando..." : "Enviar enlace"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setForgotMode(false);
                setForgotMessage(null);
              }}
              className="w-full text-center text-sm font-semibold text-slate-600 hover:text-slate-900"
            >
              Volver a iniciar sesión
            </button>
          </form>
        </Card>
      </div>
    );
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
          <button
            type="button"
            onClick={() => {
              setForgotMode(true);
              setError(null);
            }}
            className="w-full text-center text-sm font-semibold text-cyan-700 hover:text-cyan-900"
          >
            ¿Olvidaste tu contraseña?
          </button>
        </form>
      </Card>
    </div>
  );
}
