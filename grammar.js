/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * The whitespace between two parts of a tag. Django splits a tag's contents on
 * whitespace, so a separator is part of the syntax and not something to skip:
 * "{% cycle 1as x %}" is the single token "1as", never "1" followed by "as".
 * Leaving it out of `extras` is what lets the grammar say so.
 *
 * A newline separates parts like any other whitespace, since Django matches a
 * tag with re.DOTALL and splits its contents on whitespace of any kind. The
 * scanner skips the same characters when it matches a name of its own.
 */
const SEP = /[ \t\r\n]+/;

/**
 * Parts of a tag, each separated from the one before it by whitespace.
 * @param {RuleOrLiteral} first
 * @param {...RuleOrLiteral} rest
 * @returns {RuleOrLiteral}
 */
function joined(first, ...rest) {
  return rest.length === 0
    ? first
    : seq(first, ...rest.flatMap((arg) => [SEP, arg]));
}

/**
 * One more part of a tag, taking the whitespace that separates it from the
 * part before it.
 * @param {RuleOrLiteral} first
 * @param {...RuleOrLiteral} rest
 * @returns {SeqRule}
 */
function part(first, ...rest) {
  return seq(SEP, joined(first, ...rest));
}

/**
 * A tag, which may hug its delimiters ("{%cycle 1%}") or not.
 * @param {RuleOrLiteral} tag
 * @param {...RuleOrLiteral} args
 * @returns {SeqRule}
 */
function block(tag, ...args) {
  return seq(
    "{%",
    optional(SEP),
    field("tag", tag),
    ...args,
    optional(SEP),
    "%}",
  );
}

/**
 * The "as name" clause that binds a tag's result in the context. Django spells
 * it the same way in every tag that takes one, so the grammar names the target
 * the same way too, matching the bindings in "for" and "with".
 * @param {GrammarSymbols<string>} $
 * @returns {SeqRule}
 */
function asVariable($) {
  return part("as", field("variable", $.identifier));
}

/**
 * @param {RuleOrLiteral[]} chosen
 * @param {RuleOrLiteral[]} rest
 * @param {RuleOrLiteral[]} spellings
 */
function walk(chosen, rest, spellings) {
  if (chosen.length > 0) {
    spellings.push(chosen.length === 1 ? chosen[0] : seq(...chosen));
  }
  rest.forEach((item, i) =>
    walk(
      [...chosen, item],
      rest.filter((_, j) => j !== i),
      spellings,
    ),
  );
}

/**
 * Every way of writing some of `items` in any order, using each at most once,
 * which is how a tag's keyword arguments reach parse_bits(). There is no
 * interleaving operator to say that directly, so the orderings are spelled
 * out; a signature names a handful of arguments at most, and one that takes
 * more takes them as **kwargs instead.
 * @param {RuleOrLiteral[]} items
 * @returns {ChoiceRule|RuleOrLiteral}
 */
function arrangements(items) {
  if (items.length >= 5) {
    throw new Error(`Too many items for arrangements: ${items.length}`);
  }
  /**
   * @type {RuleOrLiteral[]}
   */
  const spellings = [];
  walk([], items, spellings);
  return spellings.length === 1 ? spellings[0] : choice(...spellings);
}

/**
 * A tag registered with Django's simple_tag helper: positional filter
 * expressions first, then "name=value" keyword arguments, then the "as name"
 * clause that Library.simple_tag gives every such tag. The helper takes the
 * whitespace between the parts itself, so a caller only describes what the
 * tag's Python signature accepts.
 *
 * Django checks the rest of the signature when it parses the tag, so what is
 * spelled here is what parse_bits() would allow: too many arguments, an
 * unknown keyword or a repeated one are all syntax errors there.
 *
 * @param {GrammarSymbols<string>} $
 * @param {boolean|number} args how many positional arguments the signature
 *   takes: true for any number (*args), a count for at most that many, or
 *   false for none
 * @param {boolean|Record<string, RuleOrLiteral>} kwargs true for any
 *   "name=value" pair (**kwargs), false for none, or the accepted names mapped
 *   to their value rules, each of which may be given at most once
 * @param {RuleOrLiteral} tag
 * @returns {SeqRule}
 */
function simpleTag($, tag, args = true, kwargs = true) {
  const parts = [];
  if (args === true) {
    parts.push(repeat(part($.filtered_value)));
  } else if (typeof args === "number" && args > 0) {
    // at most `args` of them, so each further one nests inside the last
    let rule = part($.filtered_value);
    for (let i = 1; i < args; ++i) {
      rule = seq(part($.filtered_value), optional(rule));
    }
    parts.push(optional(rule));
  }
  if (kwargs === true) {
    // parse_bits refuses a keyword argument the tag already holds, whatever
    // **kwargs it takes, so the scanner keeps the names rather than the grammar
    parts.unshift($._tag_open);
    parts.push(
      repeat(part(seq($._kwarg_name, $.identifier, "=", $.filtered_value))),
    );
  } else if (kwargs) {
    parts.unshift($._tag_open);
    // a known signature: any of the names it accepts, in any order, none twice
    const named = Object.entries(kwargs).map(([name, value]) =>
      part(seq($._kwarg_name, name, "=", value)),
    );
    parts.push(repeat(choice(...named)));
  }
  return block(tag, ...parts, optional(asVariable($)));
}

/**
 * Django checks a filter's argument count against the registered function
 * while it parses the template, so the arity of a builtin is syntax here:
 * "length:2" and a bare "add" are both errors.
 */
const FILTERS_WITHOUT_ARGUMENT = [
  "addslashes",
  "capfirst",
  "escape",
  "escapejs",
  "escapeseq",
  "filesizeformat",
  "first",
  "force_escape",
  "iriencode",
  "last",
  "length",
  "linebreaks",
  "linebreaksbr",
  "linenumbers",
  "lower",
  "make_list",
  "phone2numeric",
  "pprint",
  "random",
  "safe",
  "safeseq",
  "slugify",
  "striptags",
  "title",
  "unordered_list",
  "upper",
  "urlize",
  "wordcount",
];

/** Builtin filters that require an argument. */
const FILTERS_WITH_ARGUMENT = [
  "add",
  "center",
  "cut",
  "default",
  "default_if_none",
  "dictsort",
  "dictsortreversed",
  "divisibleby",
  "get_digit",
  "join",
  "ljust",
  "rjust",
  "slice",
  "stringformat",
  "truncatechars",
  "truncatechars_html",
  "truncatewords",
  "truncatewords_html",
  "urlizetrunc",
  "wordwrap",
];

/** Builtin filters that take an argument or no argument. */
const FILTERS_WITH_OPTIONAL_ARGUMENT = [
  "date",
  "floatformat",
  "json_script",
  "pluralize",
  "time",
  "timesince",
  "timeuntil",
  "urlencode",
  "yesno",
];

/**
 * django.templatetags.l10n. A library's filters need the same arity treatment
 * as a builtin's, but are kept apart from them so that the builtin parity
 * check has a list to compare against. queries/libraries.scm records which
 * library a name came from.
 */
const L10N_FILTERS_WITHOUT_ARGUMENT = ["localize", "unlocalize"];

/** django.templatetags.tz. */
const TZ_FILTERS_WITHOUT_ARGUMENT = ["localtime", "utc"];
const TZ_FILTERS_WITH_ARGUMENT = ["timezone"];

/** django.templatetags.i18n. */
const I18N_FILTERS_WITHOUT_ARGUMENT = [
  "language_bidi",
  "language_name",
  "language_name_local",
  "language_name_translated",
];

/**
 * The words that head an end tag or a part of a tag group. Each is a token
 * only inside the group it belongs to, so anywhere else the lexer reads it as
 * an identifier and custom_tag accepts it: "{% endif %}" on its own parsed as
 * a tag some library registered. Reserving them where a tag is named makes
 * them an error again, while leaving them usable as ordinary words elsewhere
 * ("{{ endif }}" is a variable, and "{% mytag endif %}" an argument).
 */
const NAMES_INSIDE_A_TAG_GROUP = [
  "elif",
  "else",
  "empty",
  "endautoescape",
  "endblock",
  "endblocktrans",
  "endblocktranslate",
  "endcache",
  "endcomment",
  "endfilter",
  "endfor",
  "endif",
  "endifchanged",
  "endlanguage",
  "endlocalize",
  "endlocaltime",
  "endpartialdef",
  "endspaceless",
  "endtimezone",
  "endverbatim",
  "endwith",
  "plural",
];

/** Django's string constant, which takes any escape but a line break. */
const STRING = /"(?:[^"\\]|\\[^\n])*"|'(?:[^'\\]|\\[^\n])*'/;

const django = grammar({
  name: "django",
  extras: ($) => [],
  word: ($) => $.identifier,
  // a separator can end a part or start the next one, which only the token
  // after it settles
  conflicts: ($) => [
    [$.template],
    [$.predicate],
    [$.library, $.load],
    [$._translate_option],
    [$._filtered_value_spaced],
    [$._filter_expression_spaced],
  ],
  supertypes: ($) => [$.template_tag, $.template_block_groups],
  externals: ($) => [
    $.matcher_error,
    $.pop_block,
    $.pop_partial,
    $.pop_verbatim,
    $.push_block,
    $.push_partial,
    $.push_verbatim,
    $.verbatim_content,
    $.comment_content,
    $._tag_open,
    $._bt_option,
    $._kwarg_name,
  ],
  reserved: {
    global: ($) => ["not", "if", "in", "is", "as", "for", "from"],
    tag_name: ($) => NAMES_INSIDE_A_TAG_GROUP,
  },
  rules: {
    template: ($) => repeat1(choice($.template_tag, $.content)),
    content: ($) => /(?:[^\{]|\{[^\{#%}])+/,
    template_tag: ($) =>
      choice($.template_block_groups, $.template_variable, $.template_comment),
    filtered_value: ($) =>
      seq($.value, optional(seq("|", $.filter_expression))),
    filter_expression: ($) => seq($.filter, repeat(seq("|", $.filter))),
    value: ($) => choice($.literal, $.variable_attribute),
    literal: ($) => choice($.number, $.string, $.translated_string),
    // digits, with single underscores allowed between them, as Python's
    // int() and float() accept ("1_000") and Django's Variable relies on
    number: ($) =>
      /[-+]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][0-9](?:_?[0-9])*)?/,
    string: ($) => STRING,
    /**
     * A string to translate at render time. Django matches "_(" and ")" as
     * part of the constant itself, so nothing may come between them and the
     * string: "_( 'a' )" is a syntax error there, not a translated literal.
     */
    translated_string: ($) => seq("_(", $.string, ")"),
    attribute: ($) => /[a-zA-Z0-9][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9][a-zA-Z0-9_]*)*/,
    variable_attribute: ($) =>
      seq($.identifier, optional(seq(".", $.attribute))),
    identifier: ($) => /[a-zA-Z][a-zA-Z0-9_]*/,
    binaryOperator: ($) =>
      choice(
        "and",
        "or",
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "in",
        prec(1, joined("not", "in")),
        "is",
        prec(1, joined("is", "not")),
      ),
    predicate: ($) =>
      seq(
        optional(seq("not", SEP)),
        $.filtered_value,
        repeat(
          seq(
            part($.binaryOperator),
            optional(part("not")),
            part($.filtered_value),
          ),
        ),
      ),
    template_variable: ($) =>
      seq(
        "{{",
        optional(SEP),
        alias($._filtered_value_spaced, $.filtered_value),
        optional(SEP),
        "}}",
      ),
    /**
     * Everything between "{{" and "}}" reaches Django as a single expression,
     * so whitespace may surround a pipe there. Inside a tag it may not: the
     * contents are split on whitespace before each argument is parsed, which
     * would leave a bare "|" as an argument of its own.
     */
    _filtered_value_spaced: ($) =>
      seq(
        $.value,
        optional(
          seq(
            optional(SEP),
            "|",
            optional(SEP),
            alias($._filter_expression_spaced, $.filter_expression),
          ),
        ),
      ),
    _filter_expression_spaced: ($) =>
      seq($.filter, repeat(seq(optional(SEP), "|", optional(SEP), $.filter))),
    template_comment: ($) => seq("{#", /(?:[^#]|#[^}])*/, "#}"),
    template_block_groups: ($) =>
      choice(
        $.autoescape_group,
        $.block_group,
        $.blocktranslate_group,
        $.cache_group,
        $.comment_group,
        $.csp_nonce_attr,
        $.csrf_token,
        $.custom_tag,
        $.cycle,
        $.debug,
        $.extends,
        $.filter_group,
        $.firstof,
        $.for_group,
        $.get_available_languages,
        $.get_current_language,
        $.get_current_language_bidi,
        $.get_current_timezone,
        $.get_language_info,
        $.get_language_info_list,
        $.get_media_prefix,
        $.get_static_prefix,
        $.if_group,
        $.ifchanged_group,
        $.include,
        $.language_group,
        $.load,
        $.localize_group,
        $.localtime_group,
        $.lorem,
        $.now,
        $.partial,
        $.partialdef_group,
        $.query_string,
        $.regroup,
        $.reset_cycle,
        $.spaceless_group,
        $.static,
        $.template_tag_block,
        $.timezone_group,
        $.translate,
        $.url_block,
        $.verbatim_group,
        $.width_ratio,
        $.with_group,
      ),
    /**
     * A filter is a name and, after a colon, at most one argument. The name is
     * a token of its own rather than part of a "name:" token so that Django's
     * builtins are keyword-extracted: a builtin written with the wrong arity
     * then cannot be read as a filter from a loaded library instead.
     */
    filter: ($) =>
      choice(
        field(
          "name",
          choice(
            ...FILTERS_WITHOUT_ARGUMENT,
            ...I18N_FILTERS_WITHOUT_ARGUMENT,
            ...L10N_FILTERS_WITHOUT_ARGUMENT,
            ...TZ_FILTERS_WITHOUT_ARGUMENT,
          ),
        ),
        seq(
          field(
            "name",
            choice(...FILTERS_WITH_ARGUMENT, ...TZ_FILTERS_WITH_ARGUMENT),
          ),
          ":",
          field("argument", $.value),
        ),
        seq(
          field("name", choice(...FILTERS_WITH_OPTIONAL_ARGUMENT)),
          optional(seq(":", field("argument", $.value))),
        ),
        // a filter a "load" brought in: its name is not known here, and so
        // neither is whether it takes an argument
        seq(
          field("name", $.identifier),
          optional(seq(":", field("argument", $.value))),
        ),
      ),
    autoescape_group: ($) =>
      seq(
        block("autoescape", part(choice("on", "off"))),
        optional($.template),
        block("endautoescape"),
      ),
    // the scanner takes the whitespace before a name it has to match itself
    block_group: ($) =>
      seq(
        block("block", field("name", $.push_block)),
        optional($.template),
        block("endblock", $.pop_block),
      ),
    blocktranslate_group: ($) =>
      choice(
        ...["blocktrans", "blocktranslate"].map((name) =>
          choice(
            seq(
              block(name, $._tag_open, repeat($._translate_option)),
              optional($._translate_body),
              block("end" + name),
            ),
            seq(
              block(
                name,
                $._tag_open,
                repeat($._translate_option),
                $._translate_count,
                repeat($._translate_option),
              ),
              $._translate_body,
              block("plural"),
              optional($._translate_body),
              block("end" + name),
            ),
          ),
        ),
      ),
    /**
     * The scanner reads the name of the option before the grammar does, so it
     * can refuse one the tag has already been given: do_block_translate keeps
     * the options it has seen in a dict and raises on a repeat.
     */
    _translate_option: ($) =>
      seq(
        $._bt_option,
        choice(
          seq(part("with"), $._tag_kwargs),
          part("context", $.filtered_value),
          part("trimmed"),
          part("asvar", field("variable", $.identifier)),
        ),
      ),
    _translate_count: ($) =>
      seq(
        $._bt_option,
        part(
          "count",
          seq(field("variable", $.identifier), "=", $.filtered_value),
        ),
      ),
    _translate_body: ($) => repeat1(choice($.content, $.template_variable)),
    /**
     * The "with" option of blocktranslate and of include takes at least one of
     * these. Django lets a name repeat here — token_kwargs builds a dict and
     * the later value wins — so unlike a simple_tag's arguments they are not
     * guarded.
     */
    _tag_kwargs: ($) =>
      repeat1(
        part(seq(field("variable", $.identifier), "=", $.filtered_value)),
      ),
    cache_group: ($) =>
      seq(
        block(
          "cache",
          part($.filtered_value),
          part(choice($.identifier, $.string)),
          repeat(part($.filtered_value)),
          optional(part(seq("using=", $.filtered_value))),
        ),
        optional($.template),
        block("endcache"),
      ),
    comment_group: ($) =>
      seq(
        block("comment", optional(part($.string))),
        optional($.comment_content),
        block("endcomment"),
      ),
    // csp_nonce_attr(context, media=None)
    csp_nonce_attr: ($) =>
      simpleTag($, "csp_nonce_attr", 1, { media: $.filtered_value }),
    csrf_token: ($) => block("csrf_token"),
    /**
     * A tag a "load" brought in. Its arguments cannot be known here, so what
     * is accepted is what Library.simple_tag and Library.inclusion_tag take,
     * which is how a tag is registered unless it needs the parser itself.
     */
    custom_tag: ($) => simpleTag($, reserved("tag_name", $.identifier)),
    cycle: ($) =>
      block(
        "cycle",
        repeat1(part($.filtered_value)),
        optional(
          seq(
            asVariable($),
            // only the as-form takes the flag
            optional(part("silent")),
          ),
        ),
      ),
    debug: ($) => block("debug"),
    extends: ($) => block("extends", part($.filtered_value)),
    filter_group: ($) =>
      seq(
        // the filter tag hands Django the rest of its text as one expression
        // rather than as split arguments, so pipes here take whitespace just
        // as they do between "{{" and "}}"
        block(
          "filter",
          part(alias($._filter_expression_spaced, $.filter_expression)),
        ),
        optional($.template),
        block("endfilter"),
      ),
    firstof: ($) =>
      block(
        "firstof",
        repeat1(part($.filtered_value)),
        optional(asVariable($)),
      ),
    for_scope: ($) =>
      prec.left(
        seq(
          block(
            "for",
            part(field("variable", $.identifier)),
            repeat(
              seq(
                optional(SEP),
                ",",
                optional(SEP),
                field("variable", $.identifier),
              ),
            ),
            part("in"),
            part($.filtered_value),
          ),
          optional($.template),
        ),
      ),
    for_group: ($) =>
      seq(
        $.for_scope,
        optional(seq(block("empty"), optional($.template))),
        block("endfor"),
      ),
    /**
     * django.templatetags.i18n. Each of these requires exactly "as <name>",
     * or "for <expression> as <name>", and rejects anything further.
     */
    get_available_languages: ($) =>
      block("get_available_languages", asVariable($)),
    get_current_language: ($) => block("get_current_language", asVariable($)),
    get_current_language_bidi: ($) =>
      block("get_current_language_bidi", asVariable($)),
    get_language_info: ($) =>
      block("get_language_info", part("for", $.filtered_value), asVariable($)),
    get_language_info_list: ($) =>
      block(
        "get_language_info_list",
        part("for", $.filtered_value),
        asVariable($),
      ),
    /**
     * django.templatetags.tz. get_current_timezone_tag requires exactly
     * "as <name>", so unlike get_static_prefix the clause is not optional and
     * nothing may follow it.
     */
    get_current_timezone: ($) => block("get_current_timezone", asVariable($)),
    get_media_prefix: ($) => block("get_media_prefix", optional(asVariable($))),
    get_static_prefix: ($) =>
      block("get_static_prefix", optional(asVariable($))),
    if_group: ($) =>
      seq(
        block("if", part($.predicate)),
        optional($.template),
        repeat(seq(block("elif", part($.predicate)), optional($.template))),
        optional(seq(block("else"), optional($.template))),
        block("endif"),
      ),
    ifchanged_group: ($) =>
      seq(
        block("ifchanged", repeat(part($.filtered_value))),
        optional($.template),
        optional(seq(block("else"), optional($.template))),
        block("endifchanged"),
      ),
    /**
     * do_include takes "with" and "only" in either order and refuses one it has
     * already been given, and "with" needs at least one argument. It calls
     * token_kwargs with support_legacy=False, so "{% include "t" with a as b %}"
     * is an error here as it is there, unlike the same clause in "{% with %}".
     */
    include: ($) =>
      block(
        "include",
        part($.filtered_value),
        optional(
          arrangements([seq(part("with"), $._tag_kwargs), part("only")]),
        ),
      ),
    /** django.templatetags.i18n. The language tag takes the one argument. */
    language_group: ($) =>
      seq(
        block("language", part($.filtered_value)),
        optional($.template),
        block("endlanguage"),
      ),
    library: ($) => seq($.identifier, optional(seq(".", $.identifier))),
    load: ($) =>
      block(
        "load",
        choice(
          seq(repeat1(part($.identifier)), part("from"), part($.library)),
          repeat1(part($.library)),
        ),
      ),
    /**
     * django.templatetags.l10n. The argument is optional and localize_tag
     * rejects anything but "on" or "off", including a second word.
     */
    localize_group: ($) =>
      seq(
        block("localize", optional(part(choice("on", "off")))),
        optional($.template),
        block("endlocalize"),
      ),
    /** django.templatetags.tz, taking "on" or "off" as localize does. */
    localtime_group: ($) =>
      seq(
        block("localtime", optional(part(choice("on", "off")))),
        optional($.template),
        block("endlocaltime"),
      ),
    lorem: ($) =>
      block(
        "lorem",
        part($.filtered_value),
        part(choice("w", "p", "b")),
        optional(part("random")),
      ),
    now: ($) => block("now", part($.string), optional(asVariable($))),
    partial: ($) => block("partial", part($.identifier)),
    partialdef_group: ($) =>
      seq(
        block("partialdef", $.push_partial, optional(part("inline"))),
        optional($.template),
        block("endpartialdef", $.pop_partial),
      ),
    // querystring(context, *args, **kwargs)
    query_string: ($) => simpleTag($, "querystring"),
    regroup: ($) =>
      block(
        "regroup",
        part($.filtered_value),
        part("by"),
        part($.attribute),
        optional(asVariable($)),
      ),
    reset_cycle: ($) => block("resetcycle", optional(part($.identifier))),
    spaceless_group: ($) =>
      seq(block("spaceless"), optional($.template), block("endspaceless")),
    static: ($) =>
      block("static", part($.filtered_value), optional(asVariable($))),
    template_tag_block: ($) =>
      block(
        "templatetag",
        part(
          choice(
            "openblock",
            "closeblock",
            "openvariable",
            "closevariable",
            "openbrace",
            "closebrace",
            "opencomment",
            "closecomment",
          ),
        ),
      ),
    /** django.templatetags.tz. timezone_tag takes the one argument. */
    timezone_group: ($) =>
      seq(
        block("timezone", part($.filtered_value)),
        optional($.template),
        block("endtimezone"),
      ),
    /**
     * django.templatetags.i18n, registered under both spellings. do_translate
     * pops its options off one at a time and refuses one it has already seen,
     * so they may be written in any order but none of them twice.
     */
    translate: ($) =>
      block(
        choice("trans", "translate"),
        part($.filtered_value),
        optional(
          arrangements([
            part("noop"),
            part("context", $.filtered_value),
            asVariable($),
          ]),
        ),
      ),
    url_block: ($) =>
      block(
        "url",
        part(choice($.string, $.identifier)),
        optional(
          choice(
            repeat1(part($.filtered_value)),
            repeat1(part(seq($.identifier, "=", $.filtered_value))),
          ),
        ),
        optional(asVariable($)),
      ),
    verbatim_group: ($) =>
      seq(
        block("verbatim", $.push_verbatim),
        optional($.verbatim_content),
        block("endverbatim", $.pop_verbatim),
      ),
    width_ratio: ($) =>
      block(
        "widthratio",
        part($.filtered_value),
        part($.filtered_value),
        part($.filtered_value),
        optional(asVariable($)),
      ),
    with_group: ($) =>
      seq(
        block(
          "with",
          repeat1(
            part(seq(field("variable", $.identifier), "=", $.filtered_value)),
          ),
        ),
        optional($.template),
        block("endwith"),
      ),
  },
});

export default django;
