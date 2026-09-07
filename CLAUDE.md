# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A tree-sitter grammar for the Django Template Language: `{% %}` tags and `{{ }}` variables.

## Commands

```sh
npm run parser-generate   # regenerate src/parser.c, grammar.json, node-types.json from grammar.js
npm run parser-test       # run the corpus tests
npm run parser-build      # build tree-sitter-django.wasm
npm run playground        # explore the grammar interactively

npx tree-sitter test -i "Cycle With As"      # one test, by name regex
npx tree-sitter test --file-name cycle.txt   # one corpus file
npx tree-sitter test -r                      # force a rebuild of the parser library
npx tree-sitter parse file.html              # parse one file
npx tree-sitter parse --debug normal f.html  # lex/shift/reduce trace
npx prettier --write grammar.js queries test CLAUDE.md   # not `.` — see below
```

`src/parser.c`, `src/grammar.json` and `src/node-types.json` are generated **and committed**, so run
`parser-generate` after every change to `grammar.js` or `src/scanner.c`.

Format with prettier over specific paths rather than `npm run format` (`prettier --write .`): that also
rewrites the generated `src/grammar.json` and `src/node-types.json`, which `parser-generate` then writes
back, producing churn in both directions.

`npm run lint` does not work: `eslint.config.mjs` was copied from a Next.js project and enables
`@typescript-eslint` and `react-hooks` rules whose plugins aren't installed. Formatting is prettier's job.

### Stale parser library

tree-sitter caches the compiled parser in `~/.cache/tree-sitter/lib/django.*`, and it has served a stale
build after edits — producing parses that contradict the current grammar (debug traces naming tokens that
no longer exist). **If a parse result disagrees with `grammar.js`, suspect this first**: rerun with
`npx tree-sitter test -r`, or delete `~/.cache/tree-sitter/lib/django*`.

## Architecture

### Whitespace is syntax, not `extras`

`extras: []`. Django's `Token.split_contents()` splits a tag's contents on whitespace _before_ parsing any
argument, so `{% cycle 1as x %}` is the single token `1as` — an error, not `1` followed by `as`. `extras`
can never be made mandatory, so the separator is an explicit token and every rule is built from helpers
that place it:

- `SEP` — `/[ \t\r\n]+/`. Newlines included: Django matches tags with `re.DOTALL`, so tags may span lines.
- `part(...)` — one tag part, taking the whitespace that separates it from the part before.
- `joined(first, ...rest)` — parts separated from _each other_, with no leading separator (`not in`).
- `block(tag, ...args)` — `{%`, optional separator, tag name, args, optional separator, `%}`; tags may
  hug their delimiters (`{%cycle 1%}`).
- `asVariable($)` — the `as name` clause. Every tag that takes one names the target `field("variable", …)`;
  do not invent a second name for it.
- `simpleTag($, tag, args, kwargs)` — a tag registered with Django's `simple_tag`, which always accepts
  positional filter expressions, then `name=value` keywords, then `as name`. `args`: `true` (`*args`), a
  count (at most N), or `false`. `kwargs`: `true` (`**kwargs`), `false`, or `{name: rule}` for a known
  signature. Put the Python signature in a comment above the call site.
- `arrangements(items)` — every ordered subset of `items`, used by `simpleTag` so that known keyword
  arguments may appear in any order but never twice. Grows as `Σ C(n,k)·k!` (65 for four names), which is
  why it is only used for signatures that name their arguments.

Consequences worth knowing before editing a rule:

- **No `token.immediate` anywhere** — without extras, adjacency is already the default. Use it only to
  forbid whitespace somewhere a separator is otherwise allowed.
- **Every optional trailing part needs somewhere for its separator to go.** Getting this wrong does not
  fail at generate time; it shows up as `MISSING` nodes in a passing-looking parse.
- **`conflicts` entries are the normal fix, not precedence.** With explicit separators the lookahead at a
  part boundary is `SEP` instead of the meaningful token, so LR(1) loses its discriminator. That is why
  `predicate` and `[$.library, $.load]` are listed there.

### Filter pipes differ by context

Django parses everything between `{{` and `}}` — and the entire remainder of `{% filter %}` — as one
`FilterExpression`, whose regex allows `\s*` on both sides of `|`. Every other tag splits its arguments on
whitespace first, so a pipe there must be tight. Hence `_filtered_value_spaced` /
`_filter_expression_spaced`, aliased back to the plain node names so the tree shape stays identical.

### External scanner (`src/scanner.c`)

Nine external tokens, for the constraints a context-free grammar cannot express:

- `push_block`/`push_partial`/`push_verbatim` and the matching `pop_*` — name matching for
  `{% block a %}…{% endblock a %}`. They share **one** stack of `{kind, name}` entries, not one stack per
  kind: the grammar already guarantees nesting, so only the innermost open tag can be closed, and there is
  never a second candidate name to try. Serialized as `<kind><name> ` per entry (`tag_kind_chars`).
- `verbatim_content`, `comment_content` — raw text up to the matching close tag.
- `matcher_error` — used by no rule; returned only if the scanner reaches an error state.

`check_space()` defines whitespace for the scanner and **must stay in sync with `SEP`**, because the
scanner skips whitespace itself while matching names.

Prefer the grammar over the scanner. A useful test: does the constraint change how the input _parses_?
Block-name matching does (it decides which close tag closes what). Things like "this keyword may not repeat"
do not, and belong in a linter instead.

### Queries

`queries/highlights.scm` lists tag and filter names explicitly, so adding either to the grammar means
adding it there too. `queries/locals.scm` relies on the `variable:` field to tell a binding from a
reference — another reason to keep `asVariable` uniform.

## Testing

Corpus tests live in `test/corpus/*.txt`, one file per tag.

- A test whose header carries `:error` asserts only that the parse fails. Prefer it for syntax-error cases
  over pinning an error-recovery tree, which is brittle.
- An omitted field annotation in an expected tree is treated as "don't care"; `--show-fields` forces fields
  into diffs.
- `test/highlights/` is **not** run by `tree-sitter test` (which looks for `test/highlight/`), and its
  `example.html` uses a custom `{% greet %}` tag the grammar does not model, so it parses with errors by
  design.

### Checking against Django itself

The `Pipfile` pins Django so the grammar can be diffed against the real implementation instead of against
documentation or memory. Both checks are worth repeating whenever tags, filters or literals change:

- **Builtin parity** — enumerate `Engine.default_builtins`, then compare `register.tags` and
  `register.filters` against `grammar.js`. For filters also compare argument arity via
  `inspect.signature`, ignoring the framework-injected `autoescape` parameter, which is never written in a
  template. Note `querystring` and `csp_nonce_attr` register as `simple_tag`, not `@register.tag`.
- **Syntax differential** — run candidate snippets through `django.template.Template()` and through
  `tree-sitter parse`, and compare accept/reject. This is how the `simple_tag` argument rules, the `_()`
  literal, and the filter-pipe spacing were pinned down.

`pipenv run` has resolved to a _different_ project's virtualenv from this directory; confirm with
`python -c "import django; print(django.get_version())"` and fall back to the explicit venv path.

### Deliberate divergences from Django

- Django has no number token: `[\w.]+` is one lexeme and `int()`/`float()` decides whether it is a literal,
  so `1a`, `1e`, `0x1f`, `1.2.3`, `1__0` and `1.` are variable _lookups_ there and errors here.
- `{% querystring page=2 page=3 %}` (a repeated `**kwargs` key) is a Django error but is not expressible in
  a context-free grammar. Repeats _are_ rejected wherever the signature names its arguments.
- `{% csp_nonce_attr "a" media="b" %}` is accepted, matching Django, which only rejects it at render time.
- `partial`/`partialdef` are Django builtins as of Django 6; `elif`/`else`/`empty` are modelled as parts of
  their enclosing tag rather than as separate tags.
