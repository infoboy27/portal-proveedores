import { useCallback } from "react";
import es from "./es.json";
import en from "./en.json";

type Dict = Record<string, string>;

const dictionaries: Record<"es" | "en", Dict> = { es, en };

// TODO: los textos-*.json recuperados por ingenieria inversa no traen acentos
// (ver README del zip original). Corregir progresivamente a medida que se
// reconstruye cada pantalla.
const currentLocale: "es" | "en" = "es";

export function useTranslation() {
  const t = useCallback((key: string) => {
    return dictionaries[currentLocale][key] ?? key;
  }, []);
  return { t };
}
