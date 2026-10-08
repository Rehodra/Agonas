import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import assign_winner  # noqa: E402
import common  # noqa: E402
import evaluate_gemma as eg  # noqa: E402
import fetch_candidate_metrics as fcm  # noqa: E402
import fetch_issue_context as fic  # noqa: E402
import render_report as rr  # noqa: E402


class Resp:
    def __init__(self, data, status=200, headers=None):
        self._d, self.status_code, self.headers = data, status, headers or {}
        self.ok = status < 400
        self.links = {}
        self.text = json.dumps(data)

    def json(self):
        return self._d


class FakeSession:
    """Routes by URL substring; records calls."""

    def __init__(self, routes):
        self.routes, self.calls, self.headers = routes, [], {}

    def request(self, method, url, params=None, json=None, timeout=None):
        self.calls.append((method, url, params, json))
        for key, val in self.routes.items():
            if key in url and (not isinstance(val, tuple) or True):
                if callable(val):
                    return val(method, url, params, json)
                return Resp(val)
        return Resp({"message": "not found"}, 404)


def test_parse_target():
    assert common.parse_target(None, "o/r#4") == ("o/r", 4)
    assert common.parse_target("o/r", "#4") == ("o/r", 4)
    with pytest.raises(SystemExit):
        common.parse_target(None, "4")
    with pytest.raises(SystemExit):
        common.parse_target("o/r", "abc")


def test_tiers():
    assert fic.tier_from_labels(["Good First Issue"]) == "starter"
    assert fic.tier_from_labels(["architecture"]) == "advanced"
    assert fic.tier_from_labels(["bug"]) == "intermediate"


def test_build_context_filters_maintainers_and_bots():
    issue = {"title": "T", "body": "see ![x](https://a/b.png)", "labels": [{"name": "good first issue"}], "assignees": []}
    comments = [
        {"user": {"login": "alex"}, "body": "Please assign me. I'd fix the parser in `foo.py`", "author_association": "NONE"},
        {"user": {"login": "boss"}, "body": "I'll take this", "author_association": "OWNER"},
        {"user": {"login": "dependabot[bot]", "type": "Bot"}, "body": "claiming this", "author_association": "NONE"},
        {"user": {"login": "chatty"}, "body": "nice issue", "author_association": "NONE"},
        {"user": {"login": "alex"}, "body": "working on this now ![s](https://x/y.png)", "author_association": "NONE"},
    ]
    ctx = fic.build_context("o/r", 4, issue, comments)
    assert [a["username"] for a in ctx["applicants"]] == ["alex"]
    assert len(ctx["applicants"][0]["comments"]) == 2
    assert ctx["applicants"][0]["media"] == ["https://x/y.png"]
    assert ctx["filtered_out"] == ["boss", "dependabot[bot]"]
    assert ctx["issue"]["tier"] == "starter" and ctx["issue"]["media"] == ["https://a/b.png"]


def test_fetch_metrics_uses_expected_queries():
    def search(method, url, params, js):
        q = params["q"]
        n = {"is:issue is:open assignee:alex": 2, "repo:o/r is:issue is:open assignee:alex": 1,
             "is:pr is:merged author:alex": 7, "repo:o/r is:pr is:merged author:alex": 3}[q]
        return Resp({"total_count": n})

    sess = FakeSession({
        "/search/issues": search,
        "/users/alex/repos": [{"full_name": "alex/a", "language": "Python", "stargazers_count": 5},
                              {"full_name": "alex/b", "language": "Python", "stargazers_count": 1},
                              {"full_name": "alex/c", "language": "Go", "stargazers_count": 9}],
        "/users/alex": {"bio": "hi", "created_at": "2020"},
    })
    m = fcm.fetch_metrics(common.GitHub(token="t", session=sess), "o/r", "alex")
    assert m["languages"] == ["Python", "Go"]
    assert (m["global_open_assigned"], m["repo_open_assigned"], m["lifetime_merged_prs"], m["repo_merged_prs"]) == (2, 1, 7, 3)
    assert m["top_repos"][0]["name"] == "alex/c"


def test_fetch_metrics_error_is_captured():
    sess = FakeSession({})
    m = fcm.fetch_metrics(common.GitHub(token="t", session=sess), "o/r", "ghost")
    assert "error" in m


def test_pillar_points():
    assert [eg.global_burden_points(n) for n in (0, 1, 2, 3, 4, 5, 9)] == [10, 7, 7, 3, 3, 0, 0]
    assert [eg.repo_monopoly_points(n) for n in (0, 1, 2, 3, 8)] == [10, 6, 2, 0, 0]


def test_score_ideal_first_timer_on_starter():
    s = eg.score_candidate("starter", {"lifetime_merged_prs": 0}, 10, 10)
    assert s["score"] == 10.0 and s["risk"] == "Low"


def test_score_hoarder_flagged():
    s = eg.score_candidate("intermediate", {"global_open_assigned": 5, "lifetime_merged_prs": 20}, 9, 9)
    assert s["risk"] == "High" and "High ghosting risk" in s["flags"]
    assert s["score"] < 8


def test_monopoly_hard_cap():
    s = eg.score_candidate("intermediate", {"repo_open_assigned": 3, "lifetime_merged_prs": 50}, 10, 10)
    assert s["score"] == 4.0 and s["breakdown"]["hard_cap_applied"] and s["risk"] == "High"


def test_veteran_penalty_on_starter():
    a = eg.score_candidate("starter", {"lifetime_merged_prs": 11}, 8, 8)["score"]
    b = eg.score_candidate("intermediate", {"lifetime_merged_prs": 11}, 8, 8)["score"]
    assert round(b - a, 1) == 2.0


def test_clamps_model_output():
    s = eg.score_candidate("intermediate", {}, 99, -5)
    assert 0 <= s["score"] <= 10


def test_parse_json_response_variants():
    assert eg.parse_json_response('{"a":1}') == {"a": 1}
    assert eg.parse_json_response('```json\n{"a":1}\n```') == {"a": 1}
    assert eg.parse_json_response('Sure! {"a": 1} hope that helps') == {"a": 1}


def make_ctx():
    return {
        "repo": "o/r",
        "issue": {"number": 4, "title": "Fix parser", "body": "Python parser bug", "labels": ["good first issue"],
                  "tier": "starter", "url": "https://github.com/o/r/issues/4"},
        "applicants": [
            {"username": "alex", "comments": ["Assign me, I traced it to parse() in parser.py and can fix it"],
             "metrics": {"languages": ["Python"], "global_open_assigned": 0, "repo_open_assigned": 0, "lifetime_merged_prs": 1}},
            {"username": "sam", "comments": ["assign me"],
             "metrics": {"languages": ["Go"], "global_open_assigned": 6, "repo_open_assigned": 3, "lifetime_merged_prs": 40}},
        ],
    }


def test_prompt_renders_all_applicants():
    p = eg.build_prompt(make_ctx())
    assert "alex" in p and "sam" in p and "Fix parser" in p and "untrusted" in p


def test_evaluate_ranks_and_handles_missing_candidate():
    judgement = {"candidates": [{"username": "ALEX", "comment_quality": 9, "domain_alignment": 9, "justification": "specific"}]}
    ev = eg.evaluate(make_ctx(), judgement, "test")
    assert [c["username"] for c in ev["candidates"]] == ["alex", "sam"]
    assert ev["candidates"][0]["rank"] == 1 and ev["candidates"][1]["score"] <= 4.0


def test_heuristic_prefers_specific_comment():
    ev = eg.evaluate(make_ctx(), eg.heuristic_judgement(make_ctx()), "heuristic")
    assert ev["candidates"][0]["username"] == "alex"


def test_call_gemma_json_mode_fallback():
    pytest.importorskip("google.genai")

    class Models:
        n = 0

        def generate_content(self, model, contents, config):
            Models.n += 1
            if Models.n == 1:
                raise RuntimeError("JSON mode is not enabled for this model")
            return type("R", (), {"text": '```json\n{"candidates": []}\n```'})()

    client = type("C", (), {"models": Models()})()
    assert eg.call_gemma("prompt", "gemma-x", client=client) == {"candidates": []}
    assert Models.n == 2


def evaluation():
    return eg.evaluate(make_ctx(), {"candidates": [
        {"username": "alex", "comment_quality": 9, "domain_alignment": 9, "justification": "specific | piped"},
        {"username": "sam", "comment_quality": 1, "domain_alignment": 2, "justification": "generic"}]}, "test")


def test_markdown_and_html_render(tmp_path):
    ev = evaluation()
    md = rr.markdown_table(ev)
    assert md.splitlines()[0] == "| Candidate | Score | Rationale | Risk |"
    assert "specific \\| piped" in md and "| alex |" in md
    html = rr.render_html(ev)
    assert "@alex" in html and "recommended" in html and "<script" not in html


def test_html_escapes_untrusted_text():
    ev = evaluation()
    ev["candidates"][0]["justification"] = "<script>alert(1)</script>"
    assert "<script>alert" not in rr.render_html(ev)


def test_assign_requires_confirm(tmp_path, capsys, monkeypatch):
    f = tmp_path / "e.json"
    f.write_text(json.dumps(evaluation()))
    monkeypatch.setattr(sys, "argv", ["x", "--data", str(f)])
    with pytest.raises(SystemExit) as e:
        assign_winner.main()
    assert "--confirm" in str(e.value)


def run_assign(tmp_path, monkeypatch, routes, token="tok", extra=()):
    f = tmp_path / "e.json"
    f.write_text(json.dumps(evaluation()))
    sess = FakeSession(routes)
    monkeypatch.setattr(assign_winner, "GitHub", lambda: common.GitHub(token=token, session=sess))
    monkeypatch.setattr(sys, "argv", ["x", "--data", str(f), "--confirm", *extra])
    assign_winner.main()
    return sess


def test_assign_posts_when_write_access(tmp_path, monkeypatch, capsys):
    def post(method, url, params, js):
        if method == "POST":
            return Resp({"assignees": [{"login": "alex"}]})
        return Resp({"permissions": {"push": True}})

    sess = run_assign(tmp_path, monkeypatch, {"/repos/o/r": post})
    posts = [c for c in sess.calls if c[0] == "POST"]
    assert posts[0][1].endswith("/repos/o/r/issues/4/assignees") and posts[0][3] == {"assignees": ["alex"]}
    assert "Assigned @alex" in capsys.readouterr().out


def test_assign_advisory_without_write_access(tmp_path, monkeypatch, capsys):
    sess = run_assign(tmp_path, monkeypatch, {"/repos/o/r": {"permissions": {"pull": True}}})
    assert not [c for c in sess.calls if c[0] == "POST"]
    assert "Recommended assignee: @alex" in capsys.readouterr().out


def test_assign_advisory_without_token(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    sess = run_assign(tmp_path, monkeypatch, {}, token=None)
    assert sess.calls == [] and "Recommended assignee" in capsys.readouterr().out


def test_assign_unknown_user_rejected(tmp_path, monkeypatch):
    with pytest.raises(SystemExit):
        run_assign(tmp_path, monkeypatch, {}, extra=("--user", "nobody"))


def test_rate_limit_retry(monkeypatch):
    monkeypatch.setattr(common.time, "sleep", lambda s: None)
    seq = [Resp({"message": "limit"}, 403, {"X-RateLimit-Remaining": "0", "Retry-After": "1"}), Resp({"ok": 1})]
    sess = FakeSession({"/x": lambda *a: seq.pop(0)})
    assert common.GitHub(token="t", session=sess).get("/x") == {"ok": 1}


def test_cli_end_to_end_heuristic(tmp_path):
    ctx = tmp_path / "c.json"
    ctx.write_text(json.dumps(make_ctx()))
    ev = tmp_path / "e.json"
    py = [sys.executable]
    r = subprocess.run(py + [str(ROOT / "scripts/evaluate_gemma.py"), "--data", str(ctx), "--out", str(ev), "--heuristic"],
                       capture_output=True, text=True, cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    r = subprocess.run(py + [str(ROOT / "scripts/render_report.py"), "--data", str(ev), "--html", str(tmp_path / "r.html"), "--markdown"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "| alex |" in r.stdout and (tmp_path / "r.html").exists()
    r = subprocess.run(py + [str(ROOT / "scripts/render_report.py"), "--data", str(ev), "--html", str(tmp_path / "r2.html")],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_normalize_judgement():
    assert eg.normalize_judgement([{"username": "a"}]) == {"candidates": [{"username": "a"}]}
    assert eg.normalize_judgement({"results": [{"username": "a"}]})["candidates"][0]["username"] == "a"
    with pytest.raises(ValueError):
        eg.normalize_judgement({"x": 1})


def test_call_gemma_falls_back_to_second_model(monkeypatch):
    pytest.importorskip("google.genai")
    monkeypatch.setattr(eg.time, "sleep", lambda s: None)
    seen = []

    class Models:
        def generate_content(self, model, contents, config):
            seen.append(model)
            if model == "big":
                raise RuntimeError("503 UNAVAILABLE")
            return type("R", (), {"text": '[{"username": "a", "comment_quality": 5, "domain_alignment": 5}]'})()

    client = type("C", (), {"models": Models()})()
    out = eg.call_gemma("p", "big", client=client, fallback="small", retries=2)
    assert out["candidates"][0]["username"] == "a" and seen == ["big", "big", "small"]


def test_call_gemma_total_failure_exits(monkeypatch):
    pytest.importorskip("google.genai")
    monkeypatch.setattr(eg.time, "sleep", lambda s: None)

    class Models:
        def generate_content(self, **kw):
            raise RuntimeError("503")

    with pytest.raises(SystemExit):
        eg.call_gemma("p", "a", client=type("C", (), {"models": Models()})(), fallback="b", retries=1)


def test_cap_flag_only_when_cap_changes_score():
    low = eg.score_candidate("starter", {"repo_open_assigned": 3, "lifetime_merged_prs": 50}, 1, 1)
    assert not low["breakdown"]["hard_cap_applied"] and "Same-repo monopoly cap (max 4.0)" not in low["flags"]
    high = eg.score_candidate("intermediate", {"repo_open_assigned": 3}, 10, 10)
    assert "Same-repo monopoly cap (max 4.0)" in high["flags"]
