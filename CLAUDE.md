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
- `arrangements(items)` — every ordered subset of `items`, so that a tag's options may be written in any
  order but never twice. Used by `translate` and `include`; keyword arguments are guarded by the scanner
  instead. Grows as `Σ C(n,k)·k!` (65 for four names), which is
  why it is only used for signatures that name their arguments.

Consequences worth knowing before editing a rule:

- **No `token.immediate` anywhere** — without extras, adjacency is already the default. Use it only to
  forbid whitespace somewhere a separator is otherwise allowed.
- **Every optional trailing part needs somewhere for its separator to go.** Getting this wrong does not
  fail at generate time; it shows up as `MISSING` nodes in a passing-looking parse.
- **`conflicts` entries are the normal fix, not precedence.** With explicit separators the lookahead at a
  part boundary is `SEP` instead of the meaningful token, so LR(1) loses its discriminator. That is why
  `predicate` and `[$.library, $.load]` are listed there.

### A tag group is a sequence of clauses

Every group is split so that each tag that opens a body owns a node of its own:

```js
if_clause: ($) => seq(block("if", part($.predicate)), optional($.template)),
if_group: ($) =>
  seq($.if_clause, repeat($.elif_clause), optional($.else_clause), block("endif")),
```

**A clause is complete without the closing tag, and that is the point.** While a template is being edited
the closer usually is not there yet, and a group rule cannot be reduced without it — so `{% if a %}{% x %}`
used to produce a top-level `ERROR` with the body's `template` parented to nothing that says which tag
opened it. A clause reduces anyway, so it survives error recovery and tooling can walk up from the cursor
to find the enclosing tag. That is what makes completion of `{% elif %}`, `{% else %}`, `{% empty %}` and
the end tags possible.

The names themselves need no hand-maintained list either: in the generated `src/node-types.json`, a group's
`children` are its clause types and its own `tag:` field holds the end tag, so the candidates for a group
are its `tag:` plus the `tag:` of each clause it can hold. For `if_group` that is `endif` from the group and
`if`, `elif`, `else` from its three clauses. Going the other way — from a clause the cursor sits in to the
groups that can hold it — is the same table read backwards, which is what an unterminated tag needs, since
the group node does not exist yet.

Do not reach for lookahead to solve that instead: `ts_language_next_state` follows only the shift on `{%`,
which lands in the "a tag starts here" state no matter how the tree is shaped.

`else_clause` is shared by `if_group` and `ifchanged_group`. `comment_group` and `verbatim_group` have no
clause — their bodies are raw scanner text that admits no tags — and neither does `blocktranslate_group`,
whose body is `_translate_body`.

**Every clause needs a `conflicts` entry.** The generator offers a left associativity instead; taking it is
what broke `{% for %}` in `06aa870`, where `prec.left` resolved the shift/reduce on `{%` statically and
silently discarded the parse in which the body continues, so every tag inside a loop became an `ERROR`.

Sharing the clauses also made the table markedly smaller — 7,200 states and a 515KB library became 5,150
and 383KB — for the same reason hoisting `blocktranslate`'s pieces into hidden rules did: the automaton
stops duplicating the body states in every group's inline context.

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

**A name that only exists inside a tag group has to be reserved instead.** `endif`, `else`, `empty` and
the rest are tokens only in the state their group opens, so where a tag is named the lexer reads them as an
identifier and `custom_tag` takes them: `{% endif %}` on its own parsed as a tag from some library. They are
listed in `NAMES_INSIDE_A_TAG_GROUP` and applied through the `tag_name` reserved context, which wraps
`custom_tag`'s name **and nothing else** — a reserved context replaces the global one inside whatever it
wraps, so wrapping the whole rule would un-reserve `as` and reject `{% mytag endif %}`. Adding a tag group
with a new part or end tag means adding its name there too.

**Builtin names must stay keyword-extractable, or the fallbacks swallow them.** `word: $.identifier` turns
each builtin's name into its own token, which the lexer prefers wherever it is valid, so a builtin commits
to its own alternative and its argument rules still apply. This is why a filter's name and its `:` are
separate tokens: while the name was spelled `"add:"` it was not word-shaped, so a bare `add` lexed as an
identifier and reached the fallback, losing the arity check for all 20 filters that require an argument.
`FILTERS_WITHOUT_ARGUMENT` / `FILTERS_WITH_ARGUMENT` / `FILTERS_WITH_OPTIONAL_ARGUMENT` carry that arity,
which Django itself enforces while it parses the template ("add requires 2 arguments, 1 provided").

### First-party libraries

Django ships `i18n`, `l10n`, `static`, `cache` and `tz` as libraries rather than builtins. Their tags are
modelled as ordinary tags (so far: `static`, `l10n`, `tz`, `cache` and `i18n`), and the grammar **never requires the `{% load %}`**, because
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

A library's filters go in their own arity tables (`L10N_FILTERS_WITHOUT_ARGUMENT`,
`TZ_FILTERS_WITH_ARGUMENT`, …) rather than into the builtin ones, so that the builtin parity check still has an exact list to compare against.

Modelling a library name makes it keyword-extracted, so it no longer reaches `custom_tag`. A project that
registers its own tag under one of these names and a different signature therefore gets a parse error. That
is accepted: these names are common enough that shadowing them is the mistake.

### External scanner (`src/scanner.c`)

Twelve external tokens, for the constraints a context-free grammar cannot express:

- `push_block`/`push_partial`/`push_verbatim` and the matching `pop_*` — name matching for
  `{% block a %}…{% endblock a %}`. They share **one** stack of `{kind, name}` entries, not one stack per
  kind: the grammar already guarantees nesting, so only the innermost open tag can be closed, and there is
  never a second candidate name to try. Serialized as `<kind><name> ` per entry (`tag_kind_chars`).
- `verbatim_content`, `comment_content` — raw text up to the matching close tag.
- `_tag_open`, `_bt_option`, `_kwarg_name` — what a tag has already been given, so that a repeated
  argument is refused: `_bt_option` for `{% blocktranslate %}`'s five options, `_kwarg_name` for `name=value`
  arguments — those of a tag registered with `simple_tag`, and the `with` bindings of `{% with %}`,
  `{% include %}` and `{% blocktranslate %}` — whose names are open-ended and so are kept as names rather
  than as a mask. `_kwarg_name` returns nothing unless the name is followed by `=`, which
  is also what tells an argument apart from the `as name` clause or the end of the tag. `_tag_open` clears
  both, and every rule that uses either has one. Both are zero width and hidden, so no tree changes. The state is one byte of
  flags, not a stack, because the tag cannot nest: its body admits no tags. It lives outside the
  `stack`/`error` union, is cleared in both branches of `reset_scanner`, and is serialized after the
  status character, so a GLR stack split copies it like everything else.
- `matcher_error` — used by no rule; returned only if the scanner reaches an error state.

`check_space()` defines whitespace for the scanner and **must stay in sync with `SEP`**, because the
scanner skips whitespace itself while matching names.

Prefer the grammar over the scanner. A useful test: does the constraint change how the input _parses_?
Block-name matching does — it decides which close tag closes what.

"This keyword may not repeat" normally does not, and belongs in a linter. `blocktranslate` is the exception,
and the reason is worth keeping straight: its five options are a fixed set, so uniqueness _is_ expressible —
`arrangements` expresses exactly that — and the scanner is standing in for a grammar that would be correct
but takes minutes to build. Where the set is open, as with `{% querystring %}`'s `**kwargs`, no grammar
can express it at all, and the scanner remembers the names the tag has been given instead of a mask of
known ones. Only `parse_bits` actually refuses a repeat: the `with` bindings of
`{% with %}`, `{% include %}` and `{% blocktranslate %}` all go through `token_kwargs`, which builds a dict
and lets the later value win. They are guarded here anyway, as a deliberate divergence — writing a name
twice has no use and is a mistake worth reporting. `{% blocktranslate %}`'s `count` is not part of that,
because Django keeps it in a dict of its own, so `{% blocktranslate with a=1 count a=2 %}` is accepted here
as it is there.

Zero-width guards carry one hazard: `recover_with_missing` can supply one without the scanner running. The
`if (valid_symbols[MatcherError]) return false;` near the top of `scan` is what stops a guard being scanned
during tree-sitter's mark-everything-valid recovery pass, so new guards go **below** it — and above the
whitespace loop, which skips the separator the grammar still has to match. A guard must also never be valid
where `content` is: a zero-width token at a content boundary preempts the internal lexer and `content` stops
matching.

### Queries

`queries/highlights.scm` lists tag and filter names explicitly, so adding either to the grammar means
adding it there too; filter names appear there without their colon. A name the grammar does not know is
captured through its field instead (`(filter name: (identifier))`, `(custom_tag tag: (identifier))`).

`queries/libraries.scm` is not a query editors run themselves; it is data for a linter, and every tag or
filter added from a library belongs in it. `queries/locals.scm` relies on the `variable:` field to tell a
binding from a reference — another reason to keep `asVariable` uniform. `{% blocktranslate %}`'s `asvar`
target carries an `asvar:` field instead, because it is written inside the tag but assigned outside it:
the scope on `blocktranslate_group` confines the `with` and `count` bindings, and would swallow `asvar`
too if it were spelled the same way. `queries/exports.scm` names it for a tool to
bind in the scope around the block, which a locals query cannot do: it places a definition in the innermost
scope containing it and offers no way out again.

`queries/conditionals.scm` is data for a tool too: `@conditional.group` / `@conditional.branch` /
`@conditional.default` say which bodies render on only some passes, so a checker can tell that
`{% if a %}{% now "Y" as n %}{% endif %}{{ n }}` may reach `{{ n }}` with nothing bound. A locals query
cannot: it matches a reference to the definition whose scope contains it and has no notion of a path not
taken. A group is exhaustive iff it has a `@conditional.default`, so each pattern captures the group
alongside one of its parts and a tool needs no list of which clause belongs to which group. Adding a tag
group whose body may be skipped means adding it there — `{% cache %}` is the non-obvious one, since a
cache hit skips the body outright and `CacheNode` pushes no context.

A branch that is also a `@local.scope` confines its bindings whichever way the branch goes, which is why
`{% for %}` is inert for that check: `ForNode` renders `nodelist_empty` **inside** the same
`context.push()` as the loop body, so `empty_clause` is a scope alongside `for_clause`.

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
- A `with` binding written twice (`{% with a=1 a=2 %}`, and the same in `{% include %}` and
  `{% blocktranslate %}`) is an error here and not in Django, where `token_kwargs` builds a dict and the
  later value wins. It has no use, so it is treated as the mistake it almost certainly is.
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
- Django's `{% cache %}` takes its fragment name as the raw word in that position and finds the cache to
  use by testing whether the last word starts with `using=`, and only when something precedes it. So
  `{% cache 500 sidebar.name %}` names a fragment there, `{% cache 500 using="c" %}` names a fragment
  called `using="c"` rather than choosing a cache, and `{% cache 500 sidebar using= %}` takes an empty
  name. All three are errors here.
- `do_for` reads `reversed` off the end of the tag before it looks for `in`, so `{% for x in reversed %}`
  is an error there and a loop over a variable named `reversed` here. Writing the flag as well
  (`{% for x in reversed reversed %}`) is accepted by both, which is why the name is not simply reserved
  in that position.
- `do_translate` refuses `as` and `noop` as the value of its `context` option, so
  `{% trans "hi" context noop %}` is an error there and a context named by the variable `noop` here.
- `partial`/`partialdef` are Django builtins as of Django 6; `elif`/`else`/`empty` are modelled as parts of
  their enclosing tag rather than as separate tags.
