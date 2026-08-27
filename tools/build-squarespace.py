"""Generate squarespace-code-block.html from index.html.

Takes the standalone site, scopes every CSS rule under `.umas-site`, makes the
header non-sticky, swaps the embedded base64 logos for a `LOGO_URL` placeholder,
prefixes in-page anchor ids with `umas-`, and wraps the result in one <div> that
can be pasted into a Squarespace Code Block.

Run from the repo root:  python3 tools/build-squarespace.py
"""
import re

src = open('index.html', encoding='utf-8').read()

css = re.search(r'<style>\n(.*?)\n  </style>', src, re.S)
if not css:
    css = re.search(r'<style>\n(.*?)\n</style>', src, re.S)
css = css.group(1)

body = re.search(r'(<header class="site">.*?</footer>)', src, re.S).group(1)
script = re.search(r'(<script>\n\(function.*?</script>)', src, re.S).group(1)
script = script.replace(
  'document.documentElement.lang = lang;',
  '(document.querySelector(".umas-site") || document.documentElement).setAttribute("lang", lang);')

SCOPE = '.umas-site'

def split_blocks(s):
    """Yield (prelude, body, had_braces) for top-level blocks; trailing text yielded as (text, None, False)."""
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

# neutralise the sticky header for embedding inside a Squarespace page
scoped = scoped.replace('position: sticky; top: 0; z-index: 10;', 'position: static;')

FONT_IMPORT = ("@import url('https://fonts.googleapis.com/css2?"
               "family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,900;1,500;1,600&"
               "family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap');\n")

# ---- rewrite the body markup ----
body = re.sub(r'src="data:image/png;base64,[^"]*"', 'src="LOGO_URL"', body)
for old, new in [
    ('href="#top"', 'href="#umas-top"'),
    ('id="story"', 'id="umas-story"'),   ('href="#story"', 'href="#umas-story"'),
    ('id="collection"', 'id="umas-collection"'), ('href="#collection"', 'href="#umas-collection"'),
    ('id="events"', 'id="umas-events"'), ('href="#events"', 'href="#umas-events"'),
    ('id="visit"', 'id="umas-visit"'),  ('href="#visit"', 'href="#umas-visit"'),
]:
    body = body.replace(old, new)
body = body.replace('<main id="top">', '<main id="umas-top">')

out = (
    '<!-- Uma\'s Books & Adventures  —  paste into a Squarespace Code Block -->\n'
    '<!-- Replace LOGO_URL (appears twice) with the uploaded logo\'s URL. -->\n'
    '<div class="umas-site">\n\n'
    '<style>\n' + FONT_IMPORT + scoped + '\n</style>\n\n'
    + body + '\n\n'
    + script + '\n\n'
    '</div>\n'
)
pass
print('wrote squarespace-code-block.html:', len(out), 'bytes')
print('LOGO_URL placeholders:', out.count('LOGO_URL'))
print('scoped rule sample:')
print('\n'.join(scoped.splitlines()[:8]))
