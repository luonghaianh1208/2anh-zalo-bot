"""Tra cứu học thuật cho người trong nhóm: PubMed (y sinh), Crossref (mọi ngành), trích dẫn.

Chỉ đọc, không cần khoá, chỉ gọi ba địa chỉ cố định (NCBI E-utilities, Crossref,
doi.org) — người dùng không đưa được URL nào vào đây.

NCBI cho tối đa ~3 yêu cầu/giây mỗi IP khi không có khoá; vượt là cả bot bị
chặn. Nên mọi lời gọi NCBI đi qua một nhịp chung (không phải giới hạn theo người).
"""

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Dict, List

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
CROSSREF = "https://api.crossref.org"
UA = "2anh-zalo-bot/academic (+https://github.com/luonghaianh1208/2anh-zalo-bot)"
MAX_RESULTS = 10
ABSTRACT_MAX_CHARS = 2500
STYLES = {"apa": "apa", "ieee": "ieee", "vancouver": "elsevier-vancouver", "harvard": "harvard-cite-them-right",
          "chicago": "chicago-author-date", "mla": "modern-language-association"}
_NCBI_INTERVAL_S = 0.4
_ncbi_lock = threading.Lock()
_ncbi_last = 0.0


class AcademicError(Exception):
    """Lỗi nói được thẳng cho người dùng."""


def _get(url: str, accept: str = "application/json") -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read(5_000_000)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise AcademicError("không tìm thấy (mã DOI/ID sai?)")
        raise AcademicError(f"dịch vụ tra cứu trả lỗi HTTP {exc.code}, thử lại sau")
    except (urllib.error.URLError, TimeoutError):
        raise AcademicError("không kết nối được dịch vụ tra cứu, thử lại sau")


def _ncbi(path: str, params: Dict[str, Any], accept: str = "application/json") -> bytes:
    global _ncbi_last
    with _ncbi_lock:
        wait = _NCBI_INTERVAL_S - (time.monotonic() - _ncbi_last)
        if wait > 0:
            time.sleep(wait)
        _ncbi_last = time.monotonic()
    query = urllib.parse.urlencode({**params, "tool": "2anh-zalo-bot"})
    return _get(f"{EUTILS}/{path}?{query}", accept)


def pubmed(query: str, limit: int = 5, abstracts: bool = True) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 5), MAX_RESULTS))
    ids = json.loads(_ncbi("esearch.fcgi", {"db": "pubmed", "term": query, "retmax": limit,
                                            "retmode": "json", "sort": "relevance"}))["esearchresult"]["idlist"]
    if not ids:
        return []
    summ = json.loads(_ncbi("esummary.fcgi", {"db": "pubmed", "id": ",".join(ids), "retmode": "json"}))["result"]
    texts: Dict[str, str] = {}
    if abstracts:
        xml = _ncbi("efetch.fcgi", {"db": "pubmed", "id": ",".join(ids), "retmode": "xml",
                                    "rettype": "abstract"}, "application/xml")
        for art in ET.fromstring(xml).iter("PubmedArticle"):
            parts = []
            for node in art.iter("AbstractText"):
                label, text = node.get("Label"), "".join(node.itertext()).strip()
                parts.append(f"{label}: {text}" if label else text)
            texts[art.findtext(".//PMID") or ""] = "\n".join(parts)[:ABSTRACT_MAX_CHARS]
    out = []
    for pmid in ids:
        s = summ.get(pmid) or {}
        item = {
            "pmid": pmid,
            "title": s.get("title"),
            "authors": [a.get("name") for a in s.get("authors", [])][:6],
            "journal": s.get("fulljournalname") or s.get("source"),
            "date": s.get("pubdate"),
            "doi": next((a.get("value") for a in s.get("articleids", []) if a.get("idtype") == "doi"), None),
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        }
        if abstracts:
            item["abstract"] = texts.get(pmid, "")
        out.append(item)
    return out


def crossref(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 5), MAX_RESULTS))
    q = urllib.parse.urlencode({"query.bibliographic": query, "rows": limit,
                                "select": "DOI,title,author,container-title,issued,type,is-referenced-by-count"})
    items = json.loads(_get(f"{CROSSREF}/works?{q}"))["message"]["items"]
    out = []
    for it in items:
        date = (it.get("issued") or {}).get("date-parts", [[None]])[0]
        out.append({
            "doi": it.get("DOI"),
            "title": (it.get("title") or [""])[0],
            "authors": [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in it.get("author", [])][:6],
            "venue": (it.get("container-title") or [""])[0],
            "year": date[0] if date else None,
            "type": it.get("type"),
            "cited_by": it.get("is-referenced-by-count"),
            "url": f"https://doi.org/{it.get('DOI')}",
        })
    return out


def cite(doi: str, style: str = "apa") -> str:
    doi = str(doi or "").strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:", "DOI:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
    if not doi.startswith("10."):
        raise AcademicError("DOI phải có dạng 10.xxxx/…")
    csl = STYLES.get(str(style or "apa").lower())
    if not csl:
        raise AcademicError(f"kiểu trích dẫn chỉ có: {', '.join(STYLES)}")
    return _get(f"https://doi.org/{urllib.parse.quote(doi)}",
                f"text/x-bibliography; style={csl}; locale=en-US").decode("utf-8", "replace").strip()
