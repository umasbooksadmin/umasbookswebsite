"""Generate squarespace-code-block.html from index.html, assets/site.css,
and assets/site.js.

Takes the standalone home page, inlines the shared stylesheet (scoped under
`.umas-site` so it can't leak into the rest of the Squarespace page) and the
shared site script, swaps the local `logo.png` reference for the logo's
Squarespace CDN URL, and wraps the result in one <div> that can be pasted
into a Squarespace Code Block.

Only index.html is covered — Squarespace Code Blocks hold one page each,
and books.html/classes.html/etc. aren't wired up for this yet (see
SQUARESPACE.md).

Run from the repo root:  python3 tools/build-squarespace.py
"""
import re

index_src = open('index.html', encoding='utf-8').read()
css_src = open('assets/site.css', encoding='utf-8').read()
js_src = open('assets/site.js', encoding='utf-8').read()

# drop /* comments */ so they don't get folded into the scoped selectors
css = re.sub(r'/\*.*?\*/', '', css_src, flags=re.S)

body = re.search(r'(<header class="site">.*?</footer>)', index_src, re.S).group(1)
page_i18n_script = re.search(r'(<script>\nwindow\.PAGE_I18N.*?</script>)', index_src, re.S).group(1)

SCOPE = '.umas-site'

def split_blocks(s):
    """Yield (prelude, body) for top-level blocks; trailing text yielded as (text, None)."""
    out, i, n, depth, start = [], 0, len(s), 0, 0
    prelude_start = 0
    while i < n:
        c = s[i]
        if c == '{':
            if depth == 0:
                prelude = s[prelude_start:i]
                depth = 1
                body_start = i + 1
            else:
                depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                out.append((prelude, s[body_start:i]))
                prelude_start = i + 1
        i += 1
    tail = s[prelude_start:]
    if tail.strip():
        out.append((tail, None))
    return out

def scope_selector(sel):
    sel = sel.strip()
    if not sel:
        return sel
    if sel in (':root', 'html', 'body'):
        return SCOPE
    if sel.startswith(':root'):
        return SCOPE + sel[len(':root'):]
    if sel == '*':
        return SCOPE + ' *'
    if sel.startswith('*'):
        return SCOPE + ' ' + sel
    return SCOPE + ' ' + sel

def scope_css(block):
    res = []
    for prelude, inner in split_blocks(block):
        if inner is None:
            continue
        p = prelude.strip()
        if p.startswith('@media') or p.startswith('@supports'):
            res.append(p + ' {\n' + scope_css(inner) + '\n}')
        elif p.startswith('@'):
            res.append(p + ' {' + inner + '}')
        else:
            sels = ', '.join(scope_selector(x) for x in p.split(','))
            res.append(sels + ' {' + inner + '}')
    return '\n'.join(res)

scoped = scope_css(css)

FONT_IMPORT = ("@import url('https://fonts.googleapis.com/css2?"
               "family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,900;1,500;1,600&"
               "family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap');\n")

# ---- rewrite the body markup ----
body = body.replace('src="logo.png"', 'src="LOGO_URL"')

# ---- scope the shared site script's <html lang> write to this block only ----
site_js = js_src.replace(
    'document.documentElement.lang = lang;',
    '(document.querySelector(".umas-site") || document.documentElement).setAttribute("lang", lang);')

# The logo already uploaded to the umasbooks.org Squarespace CDN. Used to also
# emit a ready-to-paste copy with no find/replace needed. Update if it changes.
LIVE_LOGO_URL = ('https://static1.squarespace.com/static/6a8c40b949196171fd54fb3c/'
                 't/6a953597bbed3c398abaf176/1788163479266/logo_umas_apostrophe.png')

out = (
    '<!-- Uma\'s Books & Adventures — paste into a Squarespace Code Block -->\n'
    '<!-- Replace LOGO_URL (appears once) with the uploaded logo\'s URL. -->\n'
    '<div class="umas-site">\n\n'
    '<style>\n' + FONT_IMPORT + scoped + '\n</style>\n\n'
    + body + '\n\n'
    + page_i18n_script + '\n\n'
    '<script>\n' + site_js + '\n</script>\n\n'
    '</div>\n'
)

with open('squarespace-code-block.html', 'w', encoding='utf-8') as f:
    f.write(out)

filled = out.replace('LOGO_URL', LIVE_LOGO_URL).replace(
    "<!-- Replace LOGO_URL (appears once) with the uploaded logo's URL. -->\n", '')
with open('squarespace-code-block.filled.html', 'w', encoding='utf-8') as f:
    f.write(filled)

print('wrote squarespace-code-block.html       ', len(out), 'bytes  (LOGO_URL x%d)' % out.count('LOGO_URL'))
print('wrote squarespace-code-block.filled.html', len(filled), 'bytes  (logo URL baked in)')
assert 'LOGO_URL' not in filled
assert '/*' not in scoped, 'CSS comments leaked into scoped output'
