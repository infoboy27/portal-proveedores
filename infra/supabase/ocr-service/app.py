import io
import re
from datetime import datetime

from flask import Flask, request, jsonify
from pdf2image import convert_from_bytes
from PIL import Image
import pytesseract
from pytesseract import Output

app = Flask(__name__)

# NCF (Numero de Comprobante Fiscal, DGII Rep. Dominicana):
# e-CF actual: letra E + 2 digitos de tipo + 10 digitos = 13 caracteres (ej. E310000000045)
# NCF fisico antiguo: letra A/B + 2 digitos de serie + 8 digitos = 11 caracteres (ej. B0100000001)
#
# Acotado a "ABE" (2026-08-31, encontrado en una prueba en vivo): antes
# aceptaba cualquier letra A-Z como prefijo. Tesseract confundio "B" con "O"
# en un NCF de prueba (B0200000099 -> O0200000099) y el patron viejo lo
# aceptaba igual, sin distinguir un OCR malo de un NCF real -- quedaba en el
# formulario como si estuviera bien. Como los unicos prefijos reales que
# emite la DGII son A/B (fisico) y E (e-CF), acotar el alfabeto hace que un
# prefijo invalido (una letra que no es A/B/E) directamente no matchee, y el
# campo quede vacio para que el proveedor lo complete a mano -- fallar
# cerrado en vez de fallar silencioso. No corrige ambiguedades DENTRO del
# alfabeto valido (ej. una E mal leida como B no se detecta), pero cubre el
# caso mas comun de letras fuera de ese conjunto.
NCF_PATTERN = re.compile(r"\b[ABE]\d{10,12}\b")
NCF_LABEL_PATTERN = re.compile(r"(?:NCF|Comprobante\s+Fiscal)[^\n]{0,40}?([ABE]\d{10,12})", re.IGNORECASE)

DATE_LABEL_PATTERN = re.compile(r"Fecha[^\n]{0,20}?(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})", re.IGNORECASE)
DATE_PATTERN = re.compile(r"\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b")

# Fecha escrita en letras (ej. "25 de agosto de 2026") -- comun en facturas
# generadas por sistemas que no usan formato numerico. Encontrado 2026-08-25:
# una factura real con este formato no extraia fecha en absoluto.
SPANISH_MONTHS = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6,
    "julio": 7, "agosto": 8, "septiembre": 9, "setiembre": 9, "octubre": 10,
    "noviembre": 11, "diciembre": 12,
}
SPANISH_DATE_PATTERN = re.compile(r"\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b", re.IGNORECASE)

# Numero de factura del proveedor (distinto del NCF): a diferencia del NCF no
# tiene un formato fijo entre proveedores, asi que SOLO se acepta si viene
# etiquetado explicitamente -- sin fallback "a ciegas" como en NCF, para no
# capturar basura y pisar lo que el proveedor ya escribio a mano.
#
# El lookahead "que contenga al menos un digito" es a proposito (encontrado
# 2026-08-25): en documentos donde "FACTURA" (titulo) y "NO. DE FACTURA"
# (etiqueta real) van en lineas separadas, el patron anterior saltaba desde
# el titulo hasta el "No." de la etiqueta de abajo y capturaba la palabra
# "DE" (de "NO. DE FACTURA") como si fuera el numero -- sin digitos, "DE"
# nunca deberia calificar como numero de factura.
INVOICE_NUMBER_LABEL_PATTERN = re.compile(
    r"(?:Factura\s*(?:No\.?|N[uú]m(?:ero)?\.?|#)|No\.?\s*(?:de\s*)?Factura|N[uú]mero\s+de\s+Factura)"
    r"\s*[:\-]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{1,19})",
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
    spanish = SPANISH_DATE_PATTERN.search(text)
    if spanish:
        day, month_name, year = spanish.groups()
        month = SPANISH_MONTHS.get(month_name.lower())
        if month:
            normalized = _normalize_date(day, str(month), year)
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


# Lineas de detalle (2026-08-31, pedido de Jonatan para poblar invoice_lines
# -- hoy la tabla existe y la UI ya la muestra en InvoiceDetail, pero nunca
# se inserta nada porque la nota original de 2026-08-25 la dejo afuera a
# proposito: con solo el texto plano de image_to_string() no hay forma de
# saber que palabras estaban en la misma fila/columna de una tabla.
#
# Esto NO resuelve ese problema de fondo -- sigue siendo heuristico y va a
# fallar en formatos de factura raros -- pero usa pytesseract.image_to_data()
# en vez de image_to_string(): trae la posicion (left/top) y el numero de
# linea de CADA palabra, lo que alcanza para reconstruir filas (agrupando
# por line_num) y ordenarlas de arriba a abajo. Con eso, una fila se toma
# como linea de factura solo si:
#   1. No es un encabezado de tabla ("Descripcion" + "Cantidad"/"Precio").
#   2. No contiene ninguna palabra de TOTAL_EXCLUDE_KEYWORDS ni "total"
#      (para no capturar subtotal/ITBIS/etc. como si fueran una linea mas).
#   3. Termina en 1 a 3 tokens que parecen montos (Cantidad, Precio Unit.,
#      Importe) -- el resto de la fila se toma como descripcion.
# Si una factura no tiene NINGUNA fila que cumpla esto (formato distinto,
# foto de mala calidad, factura sin tabla) se devuelve una lista vacia en
# vez de inventar algo -- mismo criterio de "fallar cerrado" que el resto
# de este archivo. Tambien se descarta todo si salen mas de 25 lineas: a
# esa altura es mucho mas probable que sea ruido (texto suelto de la
# factura mal agrupado) que una tabla real de esa longitud.
_MONEY_TOKEN = re.compile(r"^(?:RD\$|US\$|\$)?\d[\d.,]*\d$|^\d$")
_HEADER_HINTS = ("descripcion", "concepto", "detalle")
_HEADER_HINTS_2 = ("cantidad", "precio", "importe", "monto", "unit")


def extract_lines(image: Image.Image) -> list[dict]:
    data = pytesseract.image_to_data(image, lang="spa", output_type=Output.DICT)
    rows: dict[tuple[int, int, int], list[dict]] = {}
    for i in range(len(data["text"])):
        word = data["text"][i].strip()
        if not word:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        rows.setdefault(key, []).append({"text": word, "left": data["left"][i], "top": data["top"][i]})

    ordered_rows = sorted(rows.values(), key=lambda words: min(w["top"] for w in words))

    result: list[dict] = []
    for words in ordered_rows:
        tokens = [w["text"] for w in sorted(words, key=lambda w: w["left"])]
        row_text = " ".join(tokens)
        lower = row_text.lower()
        if len(row_text) < 3:
            continue
        if any(kw in lower for kw in TOTAL_EXCLUDE_KEYWORDS) or "total" in lower:
            continue
        if any(h in lower for h in _HEADER_HINTS) and any(h in lower for h in _HEADER_HINTS_2):
            continue

        tail: list[str] = []
        idx = len(tokens) - 1
        while idx >= 0 and _MONEY_TOKEN.match(tokens[idx]):
            tail.insert(0, tokens[idx])
            idx -= 1
        if not tail:
            continue

        description = " ".join(tokens[: idx + 1]).strip(" -:")
        if len(description) < 3:
            continue

        amounts = [a for a in (_normalize_amount(t) for t in tail) if a is not None]
        if not amounts:
            continue

        entry = {"description": description, "quantity": None, "unitPrice": None, "amount": amounts[-1]}
        if len(amounts) >= 3:
            entry["quantity"], entry["unitPrice"] = amounts[0], amounts[1]
        elif len(amounts) == 2:
            entry["quantity"] = amounts[0]
        result.append(entry)

    if len(result) > 25:
        return []
    for i, entry in enumerate(result, start=1):
        entry["sequence"] = i
    return result


@app.route("/", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "ocr-service"})


@app.route("/extract", methods=["POST"])
def extract():
    file_bytes = request.get_data()
    if not file_bytes:
        return jsonify({"ok": False, "error": "Body vacio, se esperaba el archivo en crudo"}), 400

    # El proveedor tambien puede subir una foto de la factura (JPG/PNG), no
    # solo PDF -- ver Invoices.tsx (accept ampliado 2026-08-26). El
    # Content-Type que manda extract-invoice-data decide la rama: una imagen
    # se lee directo con Tesseract, sin pasar por pdf2image (que solo sabe
    # rasterizar PDFs).
    content_type = (request.content_type or "").lower()
    is_image = content_type.startswith("image/")

    if is_image:
        try:
            image = Image.open(io.BytesIO(file_bytes))
        except Exception as exc:  # noqa: BLE001
            return jsonify({"ok": False, "error": f"No se pudo leer la imagen: {exc}"}), 422
    else:
        try:
            pages = convert_from_bytes(file_bytes, dpi=200, first_page=1, last_page=1)
        except Exception as exc:  # noqa: BLE001
            return jsonify({"ok": False, "error": f"No se pudo rasterizar el PDF: {exc}"}), 422
        if not pages:
            return jsonify({"ok": False, "error": "El PDF no tiene paginas"}), 422
        image = pages[0]

    text = pytesseract.image_to_string(image, lang="spa")

    return jsonify(
        {
            "ok": True,
            "text": text,
            "invoiceDate": extract_date(text),
            "invoiceTaxNumber": extract_ncf(text),
            "invoiceNumber": extract_invoice_number(text),
            "totalAmount": extract_total(text),
            "lines": extract_lines(image),
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
