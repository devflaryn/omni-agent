"""Internet access tools: search the web, read pages, and download files.

Why Jina by default
-------------------
Search (`web_search`) and page reading (`read_webpage`) go through Jina AI's
endpoints (s.jina.ai / r.jina.ai), which fetch the target SERVER-SIDE and return
clean text/markdown. That is deliberate: when an agent scrapes a search engine
and then opens several result pages directly, the target sites' bot detection
trips and you start getting CAPTCHAs / HTTP 429 after just a few pages (the
"captcha after 3 sites" problem). Routing through Jina means the sites see
Jina's infrastructure instead of us, so that wall doesn't get hit, and the
result already comes back as readable text instead of raw HTML.

Rate limits: Jina works with no key for light use. Set a (free) key via the
JINA_API_KEY environment variable to raise the limits substantially — this is
the reliable fix if you do a lot of searching in one run. If Jina is
unreachable, each tool falls back to a direct request (DuckDuckGo for search,
a plain fetch for reading) so the tool still works.

Downloads (`download_file`) fetch straight from the origin (a direct file
download doesn't trip search-engine CAPTCHAs) and stream into the workspace so
the file shows up in the tree and other tools can use it.

No paid/keyed services are required: search uses DuckDuckGo (two keyless
endpoints), reading uses Jina Reader (keyless for light use), downloads hit the
origin directly. A free JINA_API_KEY is optional and only raises rate limits.
If a keyless engine is served a CAPTCHA / anti-bot interstitial instead of real
content, `_looks_like_blocked` detects it so we fail over to the next free
backend (search) or report the wall honestly (read) rather than handing the
model a challenge page as if it were the answer.
"""
import os
import re
import time
import html
import urllib.parse

import requests

from tool_registry import registry
from tools.common import normalize_path, wpath
from host_exec import workspace_root

# A realistic desktop browser UA for the direct-fetch fallbacks; some origins
# 403 the default python-requests UA.
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

_JINA_READER = "https://r.jina.ai/"
_JINA_SEARCH = "https://s.jina.ai/"
_HTTP_TIMEOUT = 60          # seconds for search / read
_DL_CONNECT_TIMEOUT = 20
_DL_READ_TIMEOUT = 120
_DEFAULT_MAX_MB = 1024      # 1 GiB default download cap; override via max_mb
_READ_CHAR_CAP = 20000      # chars returned by read_webpage before truncating

_session = requests.Session()


def _jina_key():
    """Optional Jina API key (raises rate limits). Read live so it can be set
    without restarting the app."""
    return (os.environ.get("JINA_API_KEY") or os.environ.get("JINA_READER_API_KEY") or "").strip()


def _jina_headers(extra=None):
    h = {"User-Agent": _UA}
    key = _jina_key()
    if key:
        h["Authorization"] = f"Bearer {key}"
    if extra:
        h.update(extra)
    return h


def _get_with_backoff(url, headers, timeout, attempts=3):
    """GET with a short backoff on 429/503 (rate limit / overloaded), so a brief
    limit doesn't fail the whole tool call. Returns the Response or raises."""
    last = None
    for i in range(attempts):
        resp = _session.get(url, headers=headers, timeout=timeout)
        if resp.status_code in (429, 503):
            last = resp
            if i < attempts - 1:
                time.sleep(1.5 * (i + 1))
                continue
        return resp
    return last


# Anti-bot / CAPTCHA / rate-limit interstitials. When a keyless engine gets
# challenged it returns a 200 page like this instead of results; we must treat
# that as a FAILURE (fall through to the next free backend) rather than parse it
# as content. Markers are specific enough not to trip on ordinary pages that
# merely mention the word "captcha".
_BLOCK_MARKERS = (
    "unusual traffic", "detected unusual", "are you a robot", "are you human",
    "verify you are human", "verify you're human", "please solve", "solve this captcha",
    "complete the captcha", "confirm you are not a robot", "not a robot",
    "just a moment...", "checking your browser before", "cf-browser-verification",
    "cf-challenge", "enable javascript and cookies to continue", "access denied",
    "our systems have detected", "ops@duckduckgo.com", "ddg-anomaly", "/anomaly",
)


def _looks_like_blocked(text):
    """True when a response looks like a CAPTCHA / anti-bot / rate-limit
    interstitial rather than real content. Conservative: needs a strong marker,
    and a page that clears the marker but is substantial is NOT flagged (so a
    long article discussing CAPTCHAs isn't a false positive)."""
    if not text:
        return False
    low = text.lower()
    hit = any(m in low for m in _BLOCK_MARKERS)
    if not hit:
        return False
    # A real page that only mentions these in passing is usually long; a
    # challenge interstitial is short. Flag when short, or when the strongest
    # unambiguous markers appear at all.
    strong = ("verify you are human", "verify you're human", "cf-browser-verification",
              "cf-challenge", "just a moment...", "ops@duckduckgo.com",
              "our systems have detected", "confirm you are not a robot")
    return any(m in low for m in strong) or len(low) < 2500


def _strip_html(raw):
    """Very small HTML->text reducer for the direct-fetch fallback (no bs4
    dependency): drop script/style, turn tags into spaces, unescape entities,
    collapse whitespace."""
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?is)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?is)</(p|div|li|h[1-6]|tr)>", "\n", raw)
    text = re.sub(r"(?s)<[^>]+>", " ", raw)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


# --- web_search --------------------------------------------------------------
def _search_jina(query, max_results):
    url = _JINA_SEARCH + "?q=" + urllib.parse.quote(query)
    # X-Respond-With: no-content -> SERP-style results (title/url/description)
    # without fetching each page's full body: far cheaper and enough to pick
    # which links are worth reading with read_webpage.
    headers = _jina_headers({"Accept": "application/json", "X-Respond-With": "no-content"})
    resp = _get_with_backoff(url, headers, _HTTP_TIMEOUT)
    if resp is None or not resp.ok:
        raise RuntimeError(f"Jina search HTTP {getattr(resp, 'status_code', '?')}")
    data = resp.json()
    items = data.get("data") or []
    results = []
    for it in items[:max_results]:
        results.append({
            "title": (it.get("title") or "").strip(),
            "url": (it.get("url") or "").strip(),
            "snippet": (it.get("description") or it.get("content") or "").strip(),
        })
    return results


def _ddg_unwrap(href):
    """DuckDuckGo links are /l/?uddg=<encoded real url> redirects — return the
    real destination."""
    um = re.search(r"[?&]uddg=([^&]+)", href)
    if um:
        return urllib.parse.unquote(um.group(1))
    if href.startswith("//"):
        return "https:" + href
    return href


def _search_duckduckgo(query, max_results):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    resp = _session.get(url, headers={"User-Agent": _UA}, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    resp.encoding = "utf-8"  # DDG serves UTF-8; don't let requests mis-guess it
    if _looks_like_blocked(resp.text):
        # A challenge/anomaly page — fail so the caller tries the next free
        # backend instead of parsing a CAPTCHA page into empty/garbage results.
        raise RuntimeError("DuckDuckGo returned an anti-bot/rate-limit page")
    # Title/URL come from result__a anchors; snippets from result__snippet, in
    # the same order — zip them so each result carries its description.
    titles = re.findall(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', resp.text, re.S)
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', resp.text, re.S)
    results = []
    for i, (href, title) in enumerate(titles[:max_results]):
        snip = _strip_html(snippets[i]) if i < len(snippets) else ""
        results.append({"title": _strip_html(title), "url": _ddg_unwrap(href), "snippet": snip})
    return results


def _search_ddg_lite(query, max_results):
    """Secondary keyless fallback: DuckDuckGo's lite endpoint (a different host /
    rate-limit bucket than the html one), so a limit on one doesn't kill both."""
    resp = _session.post("https://lite.duckduckgo.com/lite/",
                         data={"q": query}, headers={"User-Agent": _UA}, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    resp.encoding = "utf-8"
    if _looks_like_blocked(resp.text):
        raise RuntimeError("DuckDuckGo Lite returned an anti-bot/rate-limit page")
    results = []
    for m in re.finditer(r'href="([^"]+)"[^>]*class="result-link"[^>]*>(.*?)</a>', resp.text, re.S):
        results.append({"title": _strip_html(m.group(2)), "url": _ddg_unwrap(m.group(1)), "snippet": ""})
        if len(results) >= max_results:
            break
    return results


@registry.register(
    name="web_search",
    description=(
        "Searches the internet and returns the top results (title, URL, and a "
        "short snippet) for a query. Use it to find documentation, CVEs, forum "
        "threads, download pages, API references, or any external information. "
        "Uses DuckDuckGo by default (no CAPTCHA for normal use, with a second "
        "DuckDuckGo endpoint as backup); if a JINA_API_KEY is set it uses Jina's "
        "higher-limit search instead. After searching, call read_webpage on a "
        "result URL to read the page (that goes through Jina Reader server-side, "
        "so opening many result pages does NOT trip their CAPTCHA walls), or "
        "download_file to save a file it points to."
    ),
    params_schema={
        "query": "string (what to search for)",
        "max_results": "int (optional, default 5, max 15) — how many results to return",
    },
    output=("A numbered list of results, each with its title, URL, and snippet. "
            "Pick a URL and pass it to read_webpage / download_file next."),
    when_to_use=("Use whenever you need information, files, or references that are not "
                 "in the workspace — e.g. look up a library's docs, find an APK/tool "
                 "download page, research a vulnerability, or confirm a fact online."),
)
def web_search(query, max_results=5):
    query = (query or "").strip()
    if not query:
        return {"error": "web_search: 'query' is required."}
    try:
        max_results = max(1, min(int(max_results), 15))
    except (TypeError, ValueError):
        max_results = 5

    # Engine order. Jina search needs a key (it 401s without one), so only try it
    # when a key is set — otherwise go straight to the keyless engines. The two
    # DuckDuckGo endpoints use different hosts / rate-limit buckets, so if one
    # gets limited the other still answers.
    engines = []
    if _jina_key():
        engines.append(("Jina", _search_jina))
    engines += [("DuckDuckGo", _search_duckduckgo), ("DuckDuckGo Lite", _search_ddg_lite)]

    results, engine, errors = [], None, []
    for name, fn in engines:
        try:
            results = fn(query, max_results)
            if results:
                engine = name
                break
        except Exception as e:
            errors.append(f"{name}: {e}")

    if not results:
        hint = ""
        if not _jina_key():
            hint = (" If search keeps failing, set a free JINA_API_KEY environment "
                    "variable to use Jina's higher-limit search backend.")
        return {"error": f"web_search found no results (backends failed: {'; '.join(errors)}).{hint}"}

    lines = [f"Search results for: {query}  [engine: {engine}]", ""]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title'] or '(no title)'}")
        lines.append(f"   {r['url']}")
        if r["snippet"]:
            snip = r["snippet"]
            lines.append("   " + (snip[:300] + ("..." if len(snip) > 300 else "")))
        lines.append("")
    lines.append("Next: call read_webpage(url=...) to read a result, or download_file(url=...) to save one.")
    return {"stdout": "\n".join(lines)}


# --- read_webpage ------------------------------------------------------------
@registry.register(
    name="read_webpage",
    description=(
        "Fetches a web page and returns its readable text (not raw HTML). Uses "
        "Jina Reader, which renders the page server-side and returns clean "
        "markdown — this avoids the bot/CAPTCHA blocks you get opening several "
        "pages directly, and strips nav/ads for you. Falls back to a direct "
        "fetch (HTML stripped to text) if Jina is unreachable. Use it to read a "
        "result from web_search, an API doc, a changelog, a forum answer, etc."
    ),
    params_schema={
        "url": "string (the full http(s) URL to read)",
        "max_chars": f"int (optional, default {_READ_CHAR_CAP}) — truncate the returned text to this many characters",
    },
    output=("The page's readable text/markdown (truncated to max_chars if long). "
            "If truncated, a note says so — narrow the URL or ask a more specific "
            "question rather than re-reading the whole page."),
    when_to_use="Use right after web_search to read a promising result, or on any known URL whose content you need.",
)
def read_webpage(url, max_chars=_READ_CHAR_CAP):
    url = (url or "").strip()
    if not re.match(r"(?i)^https?://", url):
        return {"error": "read_webpage: 'url' must be a full http(s) URL."}
    try:
        max_chars = max(500, min(int(max_chars), 100000))
    except (TypeError, ValueError):
        max_chars = _READ_CHAR_CAP

    text, source, err = "", None, None
    # Primary: Jina Reader (server-side render -> clean markdown).
    try:
        resp = _get_with_backoff(_JINA_READER + url, _jina_headers({"X-Return-Format": "markdown"}), _HTTP_TIMEOUT)
        if resp is not None and resp.ok and resp.text.strip():
            text, source = resp.text, "Jina Reader"
        else:
            err = f"Jina HTTP {getattr(resp, 'status_code', '?')}"
    except Exception as e:
        err = str(e)

    # Fallback: direct fetch + strip tags.
    if not text:
        try:
            resp = _session.get(url, headers={"User-Agent": _UA}, timeout=_HTTP_TIMEOUT)
            resp.raise_for_status()
            ctype = resp.headers.get("Content-Type", "")
            if "html" in ctype or "<html" in resp.text[:2000].lower():
                candidate = _strip_html(resp.text)
            else:
                candidate = resp.text
            # Don't hand back a CAPTCHA / anti-bot interstitial as if it were the
            # page — report it honestly so the model doesn't act on junk.
            if _looks_like_blocked(candidate):
                err = f"{err or ''} | direct: site returned an anti-bot/CAPTCHA page".strip(" |")
            else:
                text, source = candidate, "direct fetch"
        except Exception as e:
            err = f"{err or ''} | direct: {e}".strip(" |")

    if not text.strip():
        hint = (" The page is behind an anti-bot/CAPTCHA wall; try a different source URL"
                " (e.g. a docs mirror, GitHub raw, or a cache)." if err and "CAPTCHA" in err else "")
        if not _jina_key():
            hint += " Setting a free JINA_API_KEY env var raises the Jina read rate limit."
        return {"error": f"read_webpage could not retrieve {url} ({err}).{hint}"}

    truncated = len(text) > max_chars
    body = text[:max_chars]
    header = f"[{source}] {url}"
    if truncated:
        body += f"\n\n[...truncated at {max_chars} chars of {len(text)}. Ask a narrower question or read a more specific URL.]"
    return {"stdout": f"{header}\n\n{body}"}


# --- download_file -----------------------------------------------------------
def _safe_workspace_dest(dest, fallback_name):
    """Resolve `dest` to an absolute host path INSIDE the workspace. If dest is
    empty or a directory, place `fallback_name` in it. Returns (abs_path, rel)
    or raises ValueError on traversal outside the workspace."""
    host_root = os.path.abspath(workspace_root())
    rel = normalize_path(dest) if dest else "."
    # Treat a trailing slash or an existing directory as a target folder.
    looks_dir = (not dest) or dest.endswith(("/", "\\")) or rel == "."
    base = os.path.abspath(os.path.join(host_root, "" if rel == "." else rel))
    if looks_dir or os.path.isdir(base):
        base = os.path.join(base, fallback_name)
    full = os.path.abspath(base)
    if full != host_root and not full.startswith(host_root + os.sep):
        raise ValueError("destination path escapes the workspace")
    rel_out = os.path.relpath(full, host_root).replace(os.sep, "/")
    return full, rel_out


def _filename_from(url, resp):
    # Prefer Content-Disposition, then the URL path's basename.
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd, re.I)
    if m:
        name = urllib.parse.unquote(m.group(1)).strip()
    else:
        path = urllib.parse.urlparse(url).path
        name = os.path.basename(path) or "download"
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ") or "download"
    return name


@registry.register(
    name="download_file",
    description=(
        "Downloads a file from a URL and saves it into the workspace so it shows "
        "up in the file tree and other tools can use it (e.g. download an APK, a "
        ".so, a wordlist, a tool release, or a dataset, then analyze it). Streams "
        "the download with a size cap, follows redirects, and reports where it "
        "saved the file, its size, and content type."
    ),
    params_schema={
        "url": "string (the full http(s) URL of the file to download)",
        "dest": ("string (optional) — where to save it inside the workspace: a "
                 "filename, a relative path, or a folder (trailing '/'). If omitted "
                 "or a folder, the filename is taken from the URL / response."),
        "max_mb": f"int (optional, default {_DEFAULT_MAX_MB}) — abort if the download exceeds this many megabytes",
    },
    output=("A confirmation with the saved workspace path, byte size, and "
            "Content-Type — or an error (bad URL, HTTP error, size cap exceeded)."),
    when_to_use=("Use to bring an external file into the workspace: a target APK to "
                 "reverse, a native library, a tool binary/release, a config, or any "
                 "asset a web_search / read_webpage pointed you to."),
)
def download_file(url, dest=None, max_mb=_DEFAULT_MAX_MB):
    url = (url or "").strip()
    if not re.match(r"(?i)^https?://", url):
        return {"error": "download_file: 'url' must be a full http(s) URL."}
    try:
        max_bytes = max(1, int(max_mb)) * 1024 * 1024
    except (TypeError, ValueError):
        max_bytes = _DEFAULT_MAX_MB * 1024 * 1024

    try:
        workspace_root()
    except RuntimeError:
        return {"error": "download_file: no active workspace — start a project first."}

    try:
        resp = _session.get(url, headers={"User-Agent": _UA}, timeout=(_DL_CONNECT_TIMEOUT, _DL_READ_TIMEOUT),
                            stream=True, allow_redirects=True)
    except requests.RequestException as e:
        return {"error": f"download_file: request failed: {e}"}
    with resp:
        if not resp.ok:
            return {"error": f"download_file: HTTP {resp.status_code} for {url}"}

        # Reject early if the server advertises a size over the cap.
        clen = resp.headers.get("Content-Length")
        if clen and clen.isdigit() and int(clen) > max_bytes:
            return {"error": f"download_file: file is {int(clen)/1048576:.1f} MB, over the {max_mb} MB cap. "
                             "Raise max_mb if you really want it."}

        fallback = _filename_from(url, resp)
        try:
            full, rel = _safe_workspace_dest(dest, fallback)
        except ValueError as e:
            return {"error": f"download_file: {e}"}

        try:
            os.makedirs(os.path.dirname(full), exist_ok=True)
        except OSError as e:
            return {"error": f"download_file: cannot create destination folder: {e}"}

        written = 0
        try:
            with open(full, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    written += len(chunk)
                    if written > max_bytes:
                        fh.close()
                        try:
                            os.remove(full)
                        except OSError:
                            pass
                        return {"error": f"download_file: exceeded the {max_mb} MB cap while downloading "
                                         f"(stopped at {written/1048576:.1f} MB). Raise max_mb to allow it."}
                    fh.write(chunk)
        except (OSError, requests.RequestException) as e:
            return {"error": f"download_file: failed while saving: {e}"}

        ctype = resp.headers.get("Content-Type", "unknown")

    return {"stdout": (
        f"Downloaded OK.\n"
        f"  Saved to: {wpath(rel)}\n"
        f"  Size: {written:,} bytes ({written/1048576:.2f} MB)\n"
        f"  Content-Type: {ctype}\n"
        f"  Source: {url}"
    )}
