import io
import re
from datetime import datetime

from flask import Flask, request, jsonify
from pdf2image import convert_from_bytes
import pytesseract

app = Flask(__name__)

# NCF (Numero de Comprobante Fiscal, DGII Rep. Dominicana):
# e-CF actual: letra E + 2 digitos de tipo + 10 digitos = 13 caracteres (ej. E310000000045)
# NCF fisico antiguo: letra A/B + 2 digitos de serie + 8 digitos = 11 caracteres (ej. B0100000001)
NCF_PATTERN = re.compile(r"\b[A-Z]\d{10,12}\b")
NCF_LABEL_PATTERN = re.compile(r"(?:NCF|Comprobante\s+Fiscal)[^\n]{0,40}?([A-Z]\d{10,12})", re.IGNORECASE)

DATE_LABEL_PATTERN = re.compile(r"Fecha[^\n]{0,20}?(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})", re.IGNORECASE)
DATE_PATTERN = re.compile(r"\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b")

# Numero de factura del proveedor (distinto del NCF): a diferencia del NCF no
# tiene un formato fijo entre proveedores, asi que SOLO se acepta si viene
# etiquetado explicitamente -- sin fallback "a ciegas" como en NCF, para no
# capturar basura y pisar lo que el proveedor ya escribio a mano.
INVOICE_NUMBER_LABEL_PATTERN = re.compile(
    r"(?:Factura\s*(?:No\.?|N[uú]m(?:ero)?\.?|#)|No\.?\s*(?:de\s*)?Factura|N[uú]mero\s+de\s+Factura)"
    r"\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{1,19})",
    re.IGNORECASE,
)

# Total de la factura: se busca por lineas (no por todo el texto junto) para
# poder excluir "Subtotal"/"Total ITBIS"/"Total Descuento" etc, que NO son el
# total a pagar. Recorre de abajo hacia arriba porque el total casi siempre
# aparece despues de las lineas de detalle.
TOTAL_EXCLUDE_KEYWORDS = ("subtotal", "sub total", "itbis", "impuesto", "descuento", "retenc", "iva")
TOTAL_PRIORITY_KEYWORDS = ("total a pagar", "total general", "gran total", "monto total", "total factura")
MONEY_PATTERN = re.compile(r"(\d[\d.,]*\d|\d)")


def _normalize_amount(raw: str) -> float | None:
    cleaned = re.sub(r"[^\d.,]", "", raw)
    if not cleaned:
        return None
    last_comma = cleaned.rfind(",")
    last_dot = cleaned.rfind(".")
    dec_sep = "," if last_comma > last_dot else "." if last_dot > last_comma else None
    if dec_sep:
        integer_part, frac_part = cleaned.rsplit(dec_sep, 1)
        integer_part = re.sub(r"[.,]", "", integer_part)
        if len(frac_part) != 2 or not frac_part.isdigit():
            return None
        normalized = f"{integer_part}.{frac_part}"
    else:
        normalized = cleaned
    try:
        return float(normalized)
    except ValueError:
        return None


def extract_ncf(text: str) -> str | None:
    labeled = NCF_LABEL_PATTERN.search(text)
    if labeled:
        return labeled.group(1)
    bare = NCF_PATTERN.search(text)
    return bare.group(0) if bare else None


def _normalize_date(day: str, month: str, year: str) -> str | None:
    try:
        day_i, month_i, year_i = int(day), int(month), int(year)
        if year_i < 100:
            year_i += 2000
        return datetime(year_i, month_i, day_i).strftime("%Y-%m-%d")
    except ValueError:
        return None


def extract_date(text: str) -> str | None:
    labeled = DATE_LABEL_PATTERN.search(text)
    if labeled:
        parts = re.split(r"[/\-]", labeled.group(1))
        normalized = _normalize_date(*parts)
        if normalized:
            return normalized
    for match in DATE_PATTERN.finditer(text):
        normalized = _normalize_date(*match.groups())
        if normalized:
            return normalized
    return None


def extract_invoice_number(text: str) -> str | None:
    match = INVOICE_NUMBER_LABEL_PATTERN.search(text)
    return match.group(1).strip() if match else None


def extract_total(text: str) -> float | None:
    priority_hit: float | None = None
    fallback_hit: float | None = None
    for line in reversed(text.splitlines()):
        lower = line.lower()
        if "total" not in lower or any(kw in lower for kw in TOTAL_EXCLUDE_KEYWORDS):
            continue
        money_matches = MONEY_PATTERN.findall(line)
        if not money_matches:
            continue
        amount = _normalize_amount(money_matches[-1])
        if amount is None:
            continue
        if any(kw in lower for kw in TOTAL_PRIORITY_KEYWORDS):
            priority_hit = priority_hit if priority_hit is not None else amount
        else:
            fallback_hit = fallback_hit if fallback_hit is not None else amount
    return priority_hit if priority_hit is not None else fallback_hit


@app.route("/", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "ocr-service"})


@app.route("/extract", methods=["POST"])
def extract():
    pdf_bytes = request.get_data()
    if not pdf_bytes:
        return jsonify({"ok": False, "error": "Body vacio, se esperaba el PDF en crudo"}), 400

    try:
        pages = convert_from_bytes(pdf_bytes, dpi=200, first_page=1, last_page=1)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"No se pudo rasterizar el PDF: {exc}"}), 422

    if not pages:
        return jsonify({"ok": False, "error": "El PDF no tiene paginas"}), 422

    text = pytesseract.image_to_string(pages[0], lang="spa")

    return jsonify(
        {
            "ok": True,
            "text": text,
            "invoiceDate": extract_date(text),
            "invoiceTaxNumber": extract_ncf(text),
            "invoiceNumber": extract_invoice_number(text),
            "totalAmount": extract_total(text),
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
