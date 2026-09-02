import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTranslation } from "@/i18n";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

// Cierre de sesion por inactividad (2026-08-31, pedido de Jonatan): hoy no
// hay ningun limite de sesion configurado -- ni en GoTrue (GOTRUE_SESSIONS_*
// sin setear) ni en el cliente (createClient con defaults: persistSession +
// autoRefreshToken renuevan el access token solo, para siempre). Alguien que
// hace login una vez se queda adentro indefinidamente hasta que cierre
// sesion a mano. Esto agrega un limite del lado del cliente, con aviso
// previo -- GoTrue solo puede cerrar la sesion de golpe (sin popup), asi que
// el aviso tiene que vivir en el front.
const INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // 30 min sin actividad
const WARNING_LEAD_MS = 60 * 1000; // avisa 60s antes de cerrar

export function IdleSessionGuard() {
  const { t } = useTranslation();
  const [showWarning, setShowWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.floor(WARNING_LEAD_MS / 1000));
  const showWarningRef = useRef(false);
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    showWarningRef.current = showWarning;
  }, [showWarning]);

  const clearTimers = useCallback(() => {
    if (warnTimer.current) clearTimeout(warnTimer.current);
    if (logoutTimer.current) clearTimeout(logoutTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
  }, []);

  const scheduleTimers = useCallback(() => {
    clearTimers();
    warnTimer.current = setTimeout(() => {
      setSecondsLeft(Math.floor(WARNING_LEAD_MS / 1000));
      setShowWarning(true);
      countdownTimer.current = setInterval(() => {
        setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
    }, INACTIVITY_LIMIT_MS - WARNING_LEAD_MS);
    logoutTimer.current = setTimeout(() => {
      supabase.auth.signOut();
      // FeatureGuard redirige solo a /login en cuanto onAuthStateChange
      // limpia session.role -- no hace falta navegar a mano aca.
    }, INACTIVITY_LIMIT_MS);
  }, [clearTimers]);

  const staySignedIn = useCallback(() => {
    setShowWarning(false);
    scheduleTimers();
  }, [scheduleTimers]);

  useEffect(() => {
    // Se suscribe UNA sola vez (no en cada cambio de showWarning) -- usa
    // showWarningRef para leer el estado actual sin tener que
    // reinscribirse, porque reinscribirse en cada render llamaria a
    // scheduleTimers() de nuevo y cancelaria la cuenta regresiva justo
    // cuando el aviso recien aparece.
    //
    // Mientras el aviso esta en pantalla, la actividad ambiental (mover el
    // mouse, hacer scroll) NO lo cancela sola a proposito -- exige el
    // click explicito en "Seguir conectado" (o cerrar el modal). Si
    // cualquier movimiento lo reseteara, un mouse jiggler o una pestana
    // con scroll automatico anularian el aviso sin que haya alguien
    // realmente ahi -- justo el caso que este mecanismo tiene que cubrir.
    function onActivity() {
      if (!showWarningRef.current) scheduleTimers();
    }
    const events: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    scheduleTimers();
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearTimers();
    };
  }, [scheduleTimers, clearTimers]);

  return (
    <Modal open={showWarning} onClose={staySignedIn} title={t("idleWarningTitle")}>
      <p className="text-sm text-slate-600">
        {t("idleWarningBody")} <strong className="text-slate-900">{secondsLeft}s</strong>.
      </p>
      <div className="mt-6 flex justify-end">
        <Button onClick={staySignedIn}>{t("idleWarningStay")}</Button>
      </div>
    </Modal>
  );
}
