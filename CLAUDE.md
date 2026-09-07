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

### Names a `{% load %}` brought in

A library's tags and filters are registered in Python, so the grammar cannot know their names, their
arity, or whether a tag is a block tag. Two fallback rules accept them:

- `custom_tag` — `simpleTag($, $.identifier)`, i.e. what `simple_tag`/`inclusion_tag` accept, which is how
  a tag is registered unless it needs the parser itself.
- the last alternative of `filter`, whose name is `$.identifier` rather than one of the builtin literals.

**Builtin names must stay keyword-extractable, or the fallbacks swallow them.** `word: $.identifier` turns
each builtin's name into its own token, which the lexer prefers wherever it is valid, so a builtin commits
to its own alternative and its argument rules still apply. This is why a filter's name and its `:` are
separate tokens: while the name was spelled `"add:"` it was not word-shaped, so a bare `add` lexed as an
identifier and reached the fallback, losing the arity check for all 20 filters that require an argument.
`FILTERS_WITHOUT_ARGUMENT` / `FILTERS_WITH_ARGUMENT` / `FILTERS_WITH_OPTIONAL_ARGUMENT` carry that arity,
which Django itself enforces while it parses the template ("add requires 2 arguments, 1 provided").

### First-party libraries

Django ships `i18n`, `l10n`, `static`, `cache` and `tz` as libraries rather than builtins. Their tags are
modelled as ordinary tags (so far: `static`), and the grammar **never requires the `{% load %}`**, because
an engine can preload a library through `OPTIONS: {"builtins": [...]}`, which makes `{% static "a" %}` valid
with no load at all.

Whether a load is present is a question about the order of nodes, not about how the template parses, so it
belongs in a tool. `queries/libraries.scm` supplies the halves — `@library.<name>` on each tag, and
`@load.library` / `@load.name` on the loads — and the tool does the join, because tree-sitter queries have
no ordering predicate to express it. What such a tool needs to know about Django's behaviour:

- Loading is **positional**: `{% trans "x" %}{% load i18n %}` is an error, because the parser adds to its
  tag dict as it walks tokens.
- Loading is **per file**: a `{% load %}` does not reach a template that `{% extends %}` or `{% include %}`
  this one.
- `{% load trans from i18n %}` makes only `trans` available, not the rest of the library.

Modelling a library name makes it keyword-extracted, so it no longer reaches `custom_tag`. A project that
registers its own tag under one of these names and a different signature therefore gets a parse error. That
is accepted: these names are common enough that shadowing them is the mistake.

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
adding it there too; filter names appear there without their colon. A name the grammar does not know is
captured through its field instead (`(filter name: (identifier))`, `(custom_tag tag: (identifier))`). `queries/libraries.scm` is not a query editors run themselves; it is data for a linter, and every tag
or filter added from a library belongs in it. `queries/locals.scm` relies on the `variable:` field to tell a binding from a
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
- **Library contents** — `django.templatetags.<name>.register` gives a library's `tags` and `filters`.
  All of them are registered with `@register.tag`, so `inspect.signature` only reports `(parser, token)`
  and a signature has to come from the differential below or from reading the compile function.
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
- A misspelled tag or filter cannot be caught: `{{ x|lenght }}` is indistinguishable from a filter some
  library registered. Cross-referencing names against `{% load %}` needs the project's Python, so it
  belongs in a linter; the `load` rule already parses the library and `from` names for one to use.
- `{% mytag %}…{% endmytag %}` parses as two sibling `custom_tag`s. Nesting them would mean guessing that
  an unknown tag is a block tag.
- A custom tag's contents are only assumed to be the `simple_tag` shape. `@register.tag` receives the raw
  token and may parse anything, so `{% mytag <<>> %}` is rejected here and not by Django.
- A library may override a builtin (`Parser.add_library` is `self.filters.update(...)`), so a project that
  redefines `length` with a different arity gets a false error here.
- Django's `static` tags ignore what follows their argument: `StaticNode.handle_token` looks for `as` two
  bits from the end, so `{% static "a" junk %}` and `{% static "a" as u v %}` are accepted there and
  rejected here, and `PrefixNode.handle_token` raises `IndexError` rather than `TemplateSyntaxError` on
  `{% get_static_prefix as %}`.
- `partial`/`partialdef` are Django builtins as of Django 6; `elif`/`else`/`empty` are modelled as parts of
  their enclosing tag rather than as separate tags.
