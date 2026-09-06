/* eslint-disable @typescript-eslint/no-unused-vars */
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
 * @param {string} tag
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
  ],
  reserved: {
    global: ($) => ["not", "if", "in", "is", "as", "for", "from"],
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
        $.comment_group,
        $.csrf_token,
        $.cycle,
        $.debug,
        $.extends,
        $.filter_group,
        $.firstof,
        $.for_group,
        $.if_group,
        $.ifchanged_group,
        $.include,
        $.load,
        $.lorem,
        $.now,
        $.partial,
        $.partialdef_group,
        $.query_string,
        $.regroup,
        $.reset_cycle,
        $.spaceless_group,
        $.template_tag_block,
        $.url_block,
        $.verbatim_group,
        $.width_ratio,
        $.with_group,
      ),
    filter: ($) =>
      choice(
        seq("add:", $.value),
        "addslashes",
        "capfirst",
        seq("center:", $.value),
        seq("cut:", $.value),
        choice(seq("date:", $.value), "date"),
        seq("default:", $.value),
        seq("default_if_none:", $.value),
        seq("dictsort:", $.value),
        seq("dictsortreversed:", $.value),
        seq("divisibleby:", $.value),
        "escape",
        "escapejs",
        "filesizeformat",
        "first",
        choice(seq("floatformat:", $.value), "floatformat"),
        "force_escape",
        seq("get_digit:", $.value),
        "iriencode",
        seq("join:", $.value),
        choice(seq("json_script:", $.value), "json_script"),
        "last",
        "length",
        seq("length_is:", $.value),
        "linebreaks",
        "linebreaksbr",
        "linenumbers",
        seq("ljust:", $.value),
        "lower",
        "make_list",
        "phone2numeric",
        choice(seq("pluralize:", $.value), "pluralize"),
        "pprint",
        "random",
        seq("rjust:", $.value),
        "safe",
        "safeseq",
        seq("slice:", $.value),
        "slugify",
        seq("stringformat:", $.value),
        "striptags",
        choice(seq("time:", $.value), "time"),
        choice(seq("timesince:", $.value), "timesince"),
        choice(seq("timeuntil:", $.value), "timeuntil"),
        "title",
        seq("truncatechars:", $.value),
        seq("truncatechars_html:", $.value),
        seq("truncatewords:", $.value),
        seq("truncatewords_html:", $.value),
        "unordered_list",
        "upper",
        choice(seq("urlencode:", $.value), "urlencode"),
        "urlize",
        seq("urlizetrunc:", $.value),
        "wordcount",
        seq("wordwrap:", $.value),
        choice(seq("yesno:", $.value), "yesno"),
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
    comment_group: ($) =>
      seq(
        block("comment", optional(part($.string))),
        optional($.comment_content),
        block("endcomment"),
      ),
    csrf_token: ($) => block("csrf_token"),
    cycle: ($) =>
      block(
        "cycle",
        repeat1(part($.filtered_value)),
        optional(
          seq(
            part("as", field("variable", $.identifier)),
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
        optional(part("as", $.identifier)),
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
        block("endifchanged"),
      ),
    include: ($) => block("include", part($.filtered_value)),
    library: ($) => seq($.identifier, optional(seq(".", $.identifier))),
    load: ($) =>
      block(
        "load",
        choice(
          seq(repeat1(part($.identifier)), part("from"), part($.library)),
          repeat1(part($.library)),
        ),
      ),
    lorem: ($) =>
      block(
        "lorem",
        part($.filtered_value),
        part(choice("w", "p", "b")),
        optional(part("random")),
      ),
    now: ($) =>
      block(
        "now",
        part($.string),
        optional(part("as", field("name", $.identifier))),
      ),
    partial: ($) => block("partial", part($.identifier)),
    partialdef_group: ($) =>
      seq(
        block("partialdef", $.push_partial, optional(part("inline"))),
        optional($.template),
        block("endpartialdef", $.pop_partial),
      ),
    query_string: ($) =>
      block(
        "querystring",
        repeat(part($.identifier)),
        repeat(part(seq($.identifier, "=", $.filtered_value))),
      ),
    regroup: ($) =>
      block(
        "regroup",
        part($.filtered_value),
        part("by"),
        part($.attribute),
        optional(part("as", field("variable", $.identifier))),
      ),
    reset_cycle: ($) => block("resetcycle", optional(part($.identifier))),
    spaceless_group: ($) =>
      seq(block("spaceless"), optional($.template), block("endspaceless")),
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
        optional(part("as", field("variable", $.identifier))),
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
        optional(part("as", field("variable", $.identifier))),
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
