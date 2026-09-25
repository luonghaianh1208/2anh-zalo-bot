"""Test tra cứu học thuật (academic.py + công cụ zalo_academic_search). Không gọi mạng.

Chạy: npm run test:py
"""

import asyncio
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import academic, tools  # noqa: E402

ESEARCH = json.dumps({"esearchresult": {"idlist": ["111", "222"]}}).encode()
ESUMMARY = json.dumps({"result": {
    "111": {"title": "Vaping and lung health", "authors": [{"name": "Nguyen A"}], "fulljournalname": "Chest",
            "pubdate": "2025 Jan", "articleids": [{"idtype": "doi", "value": "10.1/abc"}]},
    "222": {"title": "E-cigarette use in teens", "authors": [], "source": "JAMA", "pubdate": "2024",
            "articleids": []},
}}).encode()
EFETCH = b"""<PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>111</PMID><Article><Abstract>
<AbstractText Label="BACKGROUND">Vaping is common.</AbstractText><AbstractText Label="RESULTS">Lungs hurt.</AbstractText>
</Abstract></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>"""
CROSSREF = json.dumps({"message": {"items": [{
    "DOI": "10.2/xyz", "title": ["Flipped classroom"], "author": [{"given": "Lan", "family": "Tran"}],
    "container-title": ["Computers & Education"], "issued": {"date-parts": [[2021, 3]]},
    "type": "journal-article", "is-referenced-by-count": 42}]}}).encode()


def fake_get(url, accept="application/json"):
    if "esearch" in url:
        return ESEARCH
    if "esummary" in url:
        return ESUMMARY
    if "efetch" in url:
        return EFETCH
    if "api.crossref.org" in url:
        return CROSSREF
    if url.startswith("https://doi.org/"):
        return f"Tran, L. (2021). Flipped classroom. [{accept}]".encode()
    raise AssertionError(url)


class AcademicTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(academic, "_get", side_effect=fake_get)
        self.get = patcher.start()
        self.addCleanup(patcher.stop)
        sleeper = mock.patch.object(academic.time, "sleep")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_pubmed_parses_summary_doi_and_structured_abstract(self):
        got = academic.pubmed("vaping", 2)
        self.assertEqual([g["pmid"] for g in got], ["111", "222"])
        self.assertEqual(got[0]["doi"], "10.1/abc")
        self.assertEqual(got[0]["journal"], "Chest")
        self.assertEqual(got[0]["abstract"], "BACKGROUND: Vaping is common.\nRESULTS: Lungs hurt.")
        self.assertEqual(got[1]["journal"], "JAMA")
        self.assertEqual(got[1]["abstract"], "")
        self.assertEqual(got[0]["url"], "https://pubmed.ncbi.nlm.nih.gov/111/")

    def test_pubmed_limit_is_clamped_and_calls_are_paced(self):
        academic.pubmed("x", 999)
        esearch_url = self.get.call_args_list[0].args[0]
        self.assertIn("retmax=10", esearch_url)
        self.assertIn("tool=2anh-zalo-bot", esearch_url)
        # 3 lời gọi NCBI liền nhau: nhịp chung buộc chờ giữa chúng.
        self.assertGreaterEqual(self.sleep.call_count, 2)

    def test_crossref(self):
        got = academic.crossref("flipped classroom", 1)
        self.assertEqual(got[0], {
            "doi": "10.2/xyz", "title": "Flipped classroom", "authors": ["Lan Tran"],
            "venue": "Computers & Education", "year": 2021, "type": "journal-article",
            "cited_by": 42, "url": "https://doi.org/10.2/xyz"})

    def test_cite_normalises_doi_and_checks_style(self):
        text = academic.cite("https://doi.org/10.2/xyz", "vancouver")
        self.assertIn("style=elsevier-vancouver", text)
        self.assertIn("doi.org/10.2/xyz", self.get.call_args.args[0])
        for bad_doi in ("abc", "http://127.0.0.1/x", ""):
            with self.assertRaises(academic.AcademicError):
                academic.cite(bad_doi)
        with self.assertRaises(academic.AcademicError):
            academic.cite("10.2/xyz", "made-up")


class ZaloAcademicToolTest(unittest.TestCase):
    def call(self, **args):
        with mock.patch.object(academic, "_get", side_effect=fake_get), mock.patch.object(academic.time, "sleep"):
            return json.loads(asyncio.run(tools.zalo_academic_search(args)))

    def test_defaults_to_pubmed(self):
        res = self.call(query="vaping teens")
        self.assertEqual(res["result"]["source"], "pubmed")
        self.assertEqual(len(res["result"]["results"]), 2)

    def test_crossref_and_cite(self):
        self.assertEqual(self.call(query="x", source="crossref")["result"]["results"][0]["doi"], "10.2/xyz")
        self.assertIn("Tran", self.call(action="cite", doi="10.2/xyz")["result"]["citation"])

    def test_empty_query_and_service_errors(self):
        self.assertFalse(self.call(query=" ")["success"])
        with mock.patch.object(academic, "_get", side_effect=academic.AcademicError("dịch vụ lỗi")):
            res = json.loads(asyncio.run(tools.zalo_academic_search({"query": "x"})))
        self.assertEqual(res["error"], "dịch vụ lỗi")

    def test_no_per_user_quota(self):
        for _ in range(40):
            self.assertTrue(self.call(query="x", source="crossref")["success"])

    def test_is_public(self):
        self.assertIn("zalo_academic_search", tools._PUBLIC_TOOL_NAMES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
