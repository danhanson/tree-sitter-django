# tree-sitter-django

A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for the Django Template Language (DTL) — the `{% %}` tags and `{{ }}` variables used in Django templates.

## Development

```sh
npm install
npm run parser-generate  # regenerate the parser from grammar.js
npm run parser-test      # run the corpus tests in test/corpus
npm run parser-build     # build the WASM binary
npm run playground       # interactively explore the grammar
```

## Divergences from Django

The grammar aims to accept what Django accepts, with one deliberate exception. Where Django takes an
input without complaint but the input is almost certainly a mistake — it parses, and then silently
renders nothing or quietly ignores half of what was written — the grammar reports an error instead.
Every case below is input Django itself accepts:

- **Number-shaped names.** Django has no number token: a word is a literal if `int()` or `float()` parses
  it and a variable lookup otherwise, so `0x1f`, `1a`, `1.`, `1.2.3` and `1__0` look up a variable of that
  name and render nothing.
- **An attribute of `True`, `False` or `None`.** Every Django context is seeded with those three names, so
  `{{ True.x }}` is an ordinary two-part lookup that can never resolve.
- **A keyword argument written twice.** `{% with a=1 a=2 %}`, and the same in `{% include %}` and
  `{% blocktranslate %}`, where Django builds a dict and lets the last value win.
- **Anything after a `{% static %}` path.** `StaticNode.handle_token` looks for `as` two words from the end
  and ignores the rest, so `{% static "a" junk %}` and `{% static "a" as url junk %}` render as if the
  extra words were not there.
- **A `{% cache %}` argument meant as something other than the fragment name.** Django takes the raw word
  in that position, so `{% cache 500 using="c" %}` names a fragment called `using="c"` rather than choosing
  a cache, and `{% cache 500 sidebar.name %}` names one with a dot in it.

In the other direction the grammar is more permissive only where it cannot know better: the names a
`{% load %}` brings in live in Python, so `{{ x|lenght }}` cannot be told from a filter some library
registered, and an unknown tag's arguments are assumed to have the shape `simple_tag` gives them.
