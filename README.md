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
  optional `as name`. So `{% mytag a b|upper "s" k=1 as out %}` parses, with the name on the `tag:` field.
  A keyword argument written twice is refused, as `parse_bits` refuses it.
- **Filters.** An unknown filter parses as `(filter name: (identifier))` with at most one `:argument`,
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
  linter; `queries/libraries.scm` and the `load` rule supply what one needs.
- **Names that only exist inside a tag group are reserved**, so `{% endif %}` or `{% empty %}` standing on
  its own is an error rather than a call to a custom tag of that name.

### Adding rules for your own tags and filters

For a project whose custom tags deserve real rules rather than the fallbacks, use this grammar as a base
grammar. `grammar(base, {...})` merges your rules into it, and a rule that redefines one the base already
has receives it as `previous`. A tag is an alternative of `template_block_groups`; a filter is an
alternative of `filter`.

```js
import django from "tree-sitter-django/grammar";

const SEP = /[ \t\r\n]+/;

export default grammar(django, {
  name: "djangox",

  rules: {
    // {% map items over rows %}
    template_block_groups: ($, previous) => choice(previous, $.map_tag),
    map_tag: ($) =>
      seq(
        "{%",
        optional(SEP),
        "map",
        SEP,
        $.filtered_value,
        SEP,
        "over",
        SEP,
        $.filtered_value,
        optional(SEP),
        "%}",
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

Four things to know:

- **Whitespace is explicit.** `extras` is empty, because Django splits a tag's contents before parsing any
  argument, so every separator has to be written out. The `part`/`block`/`simpleTag` helpers the base
  grammar is built from are private to it, hence the `SEP` above.
- **A new name wins over the fallback.** `shout` becomes a token of its own, so it commits to your
  alternative and your arity applies — `{{ x|shout }}` is now an error, while names you have not modelled
  still fall through to `(filter name: (identifier))`.
- **A tag with a body needs a `conflicts` entry**, as every clause in the base grammar does:
  `conflicts: ($, previous) => [...previous, [$.map_clause]]`. The generator offers an associativity
  instead; taking it silently discards the parse in which the body continues. Its end tag is not reserved
  either, so a stray `{% endmap %}` parses as a `custom_tag` rather than an error — `reserved` takes no
  `previous`, so the `tag_name` list cannot be added to a name at a time.
- **The external scanner has to be re-exported under your grammar's name**, or block-name matching and the
  repeated-argument guards will not link. `exports` cannot deliver it — that is Node's resolver, and the
  scanner is C — so give your grammar a `src/scanner.c` that renames the base's five entry points to the
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

In the other direction the grammar is more permissive only where it cannot know better, which is what the
fallbacks above are for.
