# tree-sitter-django

A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for the Django Template Language (DTL) — the `{% %}` tags, `{{ }}` variables and `{# #}` comments used in Django templates.

## Coverage

Every tag and filter Django ships as a builtin is modelled — 28 tags and 57 filters as of Django 6.1 —
and so is every tag and filter of the five libraries below. Arguments are part of the grammar rather than
something a linter checks later, so a builtin written with the wrong ones is a parse error: `{{ x|length:2 }}`
and `{% now %}` do not parse, because `length` takes no argument and `now` requires one.

The target is Django 6.1, including the builtins Django 6 added (`{% partial %}`, `{% partialdef %}`,
`{% querystring %}`, `{% csp_nonce_attr %}`). Rather than being written from the documentation, the grammar
is checked against a real Django — `Pipfile.lock` pins the version — by enumerating `Engine.default_builtins`
for the tag and filter lists and their arities, and by running candidate snippets through both
`django.template.Template()` and this parser to compare what each accepts. Where the two deliberately
disagree is listed under [Divergences](#divergences-from-django).

## Using it

There is no published package yet, and no language bindings — those are coming. What is here today:

- **`src/parser.c` and `src/scanner.c` are generated and committed**, so any tree-sitter host can compile
  them directly without running the CLI. The scanner is required: block-name matching
  (`{% block a %}…{% endblock a %}`), the repeated-argument guards and the missing-tag markers live in it.
- **`npm run parser-build`** produces `tree-sitter-django.wasm` for a `web-tree-sitter` host or an editor
  that loads Wasm grammars. It is a build artifact rather than a checked-in one, so it has to be built
  (or shipped by a release) before anything can load it.
- **`queries/`** holds the highlight, locals, tags, injection and error queries an editor loads, plus three files
  meant for a linter. See [Queries](#queries).
- **`tree-sitter.json`** names the grammar `django`, scopes it `source.django`, and points at the query
  files, which is what a tree-sitter host reads to wire all of the above together.

## Development

```sh
npm install
npm run parser-generate  # regenerate the parser from grammar.js
npm run parser-test      # run the corpus tests in test/corpus
npm run parser-build     # build the WASM binary
npm run playground       # interactively explore the grammar
```

`src/parser.c`, `src/grammar.json` and `src/node-types.json` are generated **and committed**, so a change
to `grammar.js` or `src/scanner.c` is only half made until `parser-generate` has run and the result is
committed alongside it. `tree-sitter test` compiles the parser itself, so a stale `src/` shows up as tests
that pass against the wrong grammar.

## Queries

Five of the files in `queries/` are query files an editor loads:

- **`highlights.scm`** — syntax highlighting. Tag and filter names are listed one by one, so a name the
  grammar knows is captured as `@function` and a name it is only tolerating as `@function.call`.
- **`locals.scm`** — scopes, definitions and references, so an editor can resolve a variable to the tag
  that bound it. A definition is a `variable:` field; the scopes are the blocks whose bindings do not
  outlive them (`{% with %}`, `{% for %}`, `{% empty %}`, `{% block %}`, `{% partialdef %}`,
  `{% blocktranslate %}`).
- **`tags.scm`** — the symbol index behind `tree-sitter tag`. A `{% partialdef %}` and the names a
  `{% load %}` brings in are definitions; every tag and filter used is a reference.
- **`injections.scm`** — marks template text and `{% verbatim %}` bodies as another language's content, so
  the HTML around the tags can be parsed by its own grammar. It names no language, leaving the editor to
  supply one.
- **`errors.scm`** — what to report as a problem: `(ERROR)` as `@error.syntax`, tree-sitter's own
  `(MISSING)` as `@error.missing`, and `@error.missing_tag` for the marker placed where a group's required
  tag is missing. An unterminated `{% if a %}x` parses as an `if_group` ending in a zero-width
  `missing_endif_tag` rather than as an `ERROR`, so completion and the scope queries keep working while
  a template is being written — and the tree reports no error of its own, so this query is how to find
  it. A marker is placed only where the scanner can tell: at the end of input, before an end tag that
  belongs to an enclosing group, or before an `{% endblock %}` naming a block further out.
  A group's tag written where no open group can hold it, such as `{% else %}` inside a `{% for %}`, is an
  `unexpected_tag`, captured as `@error.unexpected_tag`.

The other three are data for a tool rather than queries an editor runs. Each captures the two halves of a
relation a tree-sitter query cannot express, and the tool does the join:

- **`libraries.scm`** — which library each tag or filter is registered in, and what each `{% load %}`
  brings in. The grammar never requires the load, so reporting a missing one is a linter's job; a query
  has no ordering predicate to compare the positions itself.
- **`exports.scm`** — a name a tag binds in the scope _around_ it rather than the scope it opens. Only
  `{% blocktranslate %}`'s `asvar` does that, and a locals query cannot say so: it places a definition in
  the innermost scope containing it and offers no way out again.
- **`conditionals.scm`** — which bodies render on only some passes, as `@conditional.group` /
  `@conditional.branch` / `@conditional.default`, so a checker can tell that
  `{% if a %}{% now "Y" as n %}{% endif %}{{ n }}` may reach `{{ n }}` with nothing bound. A group is
  exhaustive exactly when one of its branches is a default. A locals query has no notion of a path not
  taken.

`tree-sitter test` loads every file in the directory, so a pattern naming a node that no longer exists
fails the suite rather than quietly matching nothing.

## Django libraries

Five of Django's template libraries are not builtins: their names have to be `{% load %}`ed, or preloaded
through the engine's `OPTIONS: {"builtins": [...]}`. Every tag and filter all five register is modelled,
with the same argument and arity rules as a builtin:

| library  | tags                                                                                                                                                                                            | filters                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `i18n`   | `trans`, `translate`, `blocktrans`, `blocktranslate`, `language`, `get_available_languages`, `get_current_language`, `get_current_language_bidi`, `get_language_info`, `get_language_info_list` | `language_bidi`, `language_name`, `language_name_local`, `language_name_translated` |
| `l10n`   | `localize`                                                                                                                                                                                      | `localize`, `unlocalize`                                                            |
| `static` | `static`, `get_static_prefix`, `get_media_prefix`                                                                                                                                               | —                                                                                   |
| `cache`  | `cache`                                                                                                                                                                                         | —                                                                                   |
| `tz`     | `localtime`, `timezone`, `get_current_timezone`                                                                                                                                                 | `localtime`, `timezone`, `utc`                                                      |

**The `{% load %}` is never required**, because an engine may have preloaded the library. Whether one is
present is a question about the order of nodes rather than about how the template parses, so it is left to
a tool: `queries/libraries.scm` marks each name with the library it came from and each `{% load %}` with
what it brings in, and the tool joins the two. Such a tool needs to know that loading is positional
(`{% trans "x" %}{% load i18n %}` is an error), that it is per file rather than inherited through
`{% extends %}` or `{% include %}`, and that `{% load trans from i18n %}` brings in only the names it lists.

Because these names are modelled, they win over the fallbacks below: a project that registers its own tag
under one of them with a different signature gets a parse error. They are common enough that shadowing
them is treated as the mistake.

## Custom tags and filters

A library's tags and filters are registered in Python, so the grammar cannot know their names, their
arity, or whether a tag opens a body. Two fallback rules accept them:

- **Tags.** Any tag the grammar does not recognise parses as `custom_tag`, with the shape `simple_tag` and
  `inclusion_tag` give: positional filter expressions, then `name=value` keyword arguments, then an
  optional `as name`. So `{% mytag a b|upper "s" k=1 as out %}` parses, with the name on the `tag_name:` field.
  A keyword argument written twice is refused, as `parse_bits` refuses it.
- **Filters.** An unknown filter parses as `(filter filter_name: (identifier))` with at most one `:argument`,
  which is all Django's expression regex allows. No arity check is possible.

Both are captured as `@function.call` rather than `@function`, so an editor can distinguish a name the
grammar knows from one it is only tolerating.

What the fallbacks cannot do:

- **A block tag is not nested.** `{% mytag %}…{% endmytag %}` is two sibling `custom_tag`s; pairing them
  would mean guessing that an unknown tag opens a body.
- **A tag registered with `@register.tag` may parse anything**, since it receives the raw token, so one
  whose arguments are not the `simple_tag` shape — `{% mytag <<>> %}` — is an error here and not in Django.
- **A misspelled name cannot be caught.** `{{ x|lenght }}` is indistinguishable from a filter some library
  registered. Cross-referencing names against `{% load %}` needs the project's Python, so it belongs in a
  linter; `queries/libraries.scm` and the `load_tag` rule supply what one needs.
- **Names that only exist inside a tag group are reserved**, so `{% endif %}` or `{% empty %}` standing on
  its own is an `unexpected_tag`, reported by `errors.scm`, rather than a call to a custom tag of that name.

### Adding rules for your own tags and filters

For a project whose custom tags deserve real rules rather than the fallbacks, use this grammar as a base
grammar. `grammar(base, {...})` merges your rules into it, and a rule that redefines one the base already
has receives it as `previous`. A tag is an alternative of `template_tag`; a filter is an
alternative of `filter`.

```js
import django from "tree-sitter-django/grammar";

export default grammar(django, {
  name: "djangox",

  conflicts: ($, previous) => [...previous, [$.loop_block]],

  rules: {
    template_tag: ($, previous) => choice(previous, $.map_tag, $.loop_group),

    // {% map items over rows %}
    map_tag: ($) =>
      seq(
        $.simpleTagOpen,
        field("tag", "map"),
        $._sep,
        $.filtered_value,
        $._sep,
        "over",
        $._sep,
        $.filtered_value,
        $.simpleTagClose,
      ),

    // {% loop x %}…{% endloop %}
    loop_tag: ($) =>
      seq(
        $.startTagOpen,
        field("tag", "loop"),
        $._sep,
        $.identifier,
        $.startTagClose,
      ),
    loop_block: ($) => seq($.loop_tag, optional($.template)),
    endloop_tag: ($) =>
      seq($.endTagOpen, field("tag", "endloop"), $.endTagClose),
    loop_group: ($) =>
      seq(
        $.loop_block,
        choice($.endloop_tag, alias($._missing_tag, $.missing_endloop_tag)),
      ),

    // {{ value|shout:"!" }}
    filter: ($, previous) =>
      choice(
        previous,
        seq(field("name", "shout"), ":", field("argument", $.value)),
      ),
  },
});
```

Seven things to know:

- **Whitespace is explicit.** `extras` is empty, because Django splits a tag's contents before parsing any
  argument, so every separator has to be written out. The `part`/`tag`/`simpleTag` helpers the base
  grammar is built from are private to it, but the separator is the hidden rule `$._sep`, and it and the
  tag utilities (`simpleTagOpen` and the rest) are rules, so an extending grammar uses them as they are.
- **Every tag begins with one of the opens**: `$.simpleTagOpen`, with `$.simpleTagClose` at its end, for a
  tag outside any group such as `map_tag`, and `startTagOpen`, `followTagOpen`, `repeatTagOpen` or
  `endTagOpen` for the tags of a group. Its
  zero-width token hands the tag's name to the scanner and is taken wherever a tag can start, so a tag
  written from a bare `"{%"` never matches: `{% map items over rows %}` would quietly parse as a
  `custom_tag` instead.
- **A new name wins over the fallback.** `shout` becomes a token of its own, so it commits to your
  alternative and your arity applies — `{{ x|shout }}` is now an error, while names you have not modelled
  still fall through to `(filter filter_name: (identifier))`.
- **A tag with a body is split the way the base grammar's are**, so every `{% %}` is a node of its own:
  a `loop_tag` ending in `$.startTagClose`, a `loop_block` of that tag and the body, an
  `endloop_tag` built from `$.endTagOpen` and `$.endTagClose`, and a `loop_group` of the block and the
  end tag. A middle tag uses `followTagOpen`/`followTagClose` if the group holds it at most once, and
  `repeatTagOpen`/`repeatTagClose` if it may repeat; the scanner trusts that choice. The block needs a
  `conflicts` entry, as every block in the base grammar does. The generator offers an associativity
  instead; taking it silently discards the parse in which the body continues.
- **End tags are not reserved**, a stray `{% endmap %}` parses as a `custom_tag` rather than an error — `reserved` takes no
  `previous`, so the `tag_name` list cannot be added to a name at a time. Instead you may drop the `custom_tag` rule to avoid parsing end tags as custom tags.
- **Your groups get missing-tag markers.** The scanner knows no group by name — a group is closed by `end`
  followed by its opening tag's name — so the `alias($._missing_tag, $.missing_endloop_tag)` choice
  above is all it takes: an unclosed `{% loop x %}`, or one left open inside an `{% if %}` that
  `{% endif %}` closes, holds a `missing_endloop_tag`. Add the name to your copy of `errors.scm`.
- **The external scanner has to be re-exported under your grammar's name**, or block-name matching and the
  repeated-argument guards will not link. Give your grammar a `src/scanner.c` that renames the base's five entry points to the
  ones your generated `parser.c` calls, and includes it:

```c
#define tree_sitter_django_external_scanner_create tree_sitter_djangox_external_scanner_create
#define tree_sitter_django_external_scanner_destroy tree_sitter_djangox_external_scanner_destroy
#define tree_sitter_django_external_scanner_scan tree_sitter_djangox_external_scanner_scan
#define tree_sitter_django_external_scanner_serialize tree_sitter_djangox_external_scanner_serialize
#define tree_sitter_django_external_scanner_deserialize tree_sitter_djangox_external_scanner_deserialize

#include "../node_modules/tree-sitter-django/src/scanner.c"
```

The base's `tree_sitter/parser.h` then resolves to your own generated copy, and the externals keep the
order they have here, so the scanner's token enum stays valid. `tree-sitter build` takes no include
path, hence the relative `#include`; the package also exports `tree-sitter-django/src/scanner.c`, so a
build step can hand the compiler an absolute path from `import.meta.resolve` where a package manager's
layout makes the relative one unreliable.

**Turning the fallbacks off.** A grammar that models every tag and filter its project uses probably does
not want `custom_tag` and `_custom_filter` accepting unrecognized names as they allow typos to parse. `previous` is the base rule whose `members` are filterable. We can filter out these rules to make the grammar more strict:

```js
template_tag: ($, previous) =>
  choice(
    ...previous.members.filter((m) => m.name !== "custom_tag"),
    $.map_tag,
  ),

filter: ($, previous) =>
  choice(
    ...previous.members.filter((m) => m.name !== "_custom_filter"),
    seq(field("name", "shout"), ":", field("argument", $.value)),
  ),
```

`{% mytag %}` and `{{ x|unknown }}` are then errors, while the builtins, the libraries and your own rules
carry on as before.

## Divergences from Django

The grammar aims to accept what Django accepts, with one deliberate exception. Where Django takes an
input without complaint but the input is almost certainly a mistake — it parses, and then silently
renders nothing or quietly ignores half of what was written — the grammar reports an error instead.
Every case below is input Django itself accepts:

- **Number-shaped names.** Django has no number token: a word is a literal if `int()` or `float()` parses
  it and a variable lookup otherwise, so `0x1f`, `1a`, `1.`, `1.2.3` and `1__0` look up a variable of that
  name and render nothing. (`1.` really is a lookup there and not a float — `Variable` rejects a trailing
  dot after parsing it — while `1.e5` is a float, and both are treated that way here.)
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

In the other direction the grammar is more permissive only where it cannot know better, which is what the
fallbacks above are for.

## License

MIT — see [LICENSE](LICENSE).
