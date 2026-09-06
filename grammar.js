/* eslint-disable @typescript-eslint/no-unused-vars */
/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * @param {string} tag
 * @param {...RuleOrLiteral} args
 * @returns {SeqRule}
 */
function block(tag, ...args) {
  return seq("{%", field("tag", tag), ...args, "%}");
}

/**
 * A keyword that must be separated from the token before it by whitespace.
 * Django splits tag contents on whitespace, so "{% cycle 1as x %}" is one
 * token and an error, not "1" followed by "as". Nothing in the lexer enforces
 * that on its own: two keywords cannot run together (the lexer would read one
 * longer identifier), but a literal can run into the keyword after it, and
 * extras can never be made mandatory. The separator is therefore a zero-width
 * external token that the scanner only emits when whitespace really precedes
 * its keyword.
 *
 * @param {RuleOrLiteral} separator
 * @param {string} keyword
 * @param {...RuleOrLiteral} args
 * @returns {SeqRule}
 */
function spaced(separator, keyword, ...args) {
  return seq(separator, keyword, ...args);
}

const django = grammar({
  name: "django",
  extras: ($) => [/[ \t]/],
  word: ($) => $.identifier,
  conflicts: ($) => [[$.template]],
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
    $._before_and,
    $._before_as,
    $._before_b,
    $._before_by,
    $._before_in,
    $._before_is,
    $._before_not,
    $._before_or,
    $._before_p,
    $._before_random,
    $._before_w,
    $._after_literal,
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
      seq($.value, optional(seq(token.immediate("|"), $.filter_expression))),
    filter_expression: ($) =>
      seq($.filter, repeat(seq(token.immediate("|"), $.filter))),
    value: ($) => choice($.literal, $.variable_attribute),
    literal: ($) => seq(choice($.number, $.string), $._after_literal),
    // digits, with single underscores allowed between them, as Python's
    // int() and float() accept ("1_000") and Django's Variable relies on
    number: ($) =>
      /[-+]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][0-9](?:_?[0-9])*)?/,
    string: ($) => /"(?:[^"\\]|\\[^\n])*"|'(?:[^'\\]|\\[^\n])*'/,
    attribute: ($) => /[a-zA-Z0-9][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9][a-zA-Z0-9_]*)*/,
    variable_attribute: ($) =>
      seq($.identifier, optional(seq(token.immediate("."), $.attribute))),
    identifier: ($) => /[a-zA-Z][a-zA-Z0-9_]*/,
    binaryOperator: ($) =>
      choice(
        spaced($._before_and, "and"),
        spaced($._before_or, "or"),
        "==",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        spaced($._before_in, "in"),
        prec(1, spaced($._before_not, "not", "in")),
        spaced($._before_is, "is"),
        prec(1, spaced($._before_is, "is", "not")),
      ),
    predicate: ($) =>
      seq(
        optional(spaced($._before_not, "not")),
        $.filtered_value,
        repeat(
          seq(
            $.binaryOperator,
            optional(spaced($._before_not, "not")),
            $.filtered_value,
          ),
        ),
      ),
    template_variable: ($) => seq("{{", $.filtered_value, "}}"),
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
        block("autoescape", choice("on", "off")),
        optional($.template),
        block("endautoescape"),
      ),
    block_group: ($) =>
      seq(
        block("block", field("name", $.push_block)),
        optional($.template),
        block("endblock", $.pop_block),
      ),
    comment_group: ($) =>
      seq(
        block("comment", optional($.string)),
        optional($.comment_content),
        block("endcomment"),
      ),
    csrf_token: ($) => block("csrf_token"),
    cycle: ($) =>
      block(
        "cycle",
        repeat1($.filtered_value),
        optional(
          spaced(
            $._before_as,
            "as",
            field("variable", $.identifier),
            // only the as-form takes the flag, and an identifier can never run
            // into it, so "silent" needs no separator of its own
            optional("silent"),
          ),
        ),
      ),
    debug: ($) => block("debug"),
    extends: ($) => block("extends", $.filtered_value),
    filter_group: ($) =>
      seq(
        block("filter", $.filter_expression),
        optional($.template),
        block("endfilter"),
      ),
    firstof: ($) =>
      block(
        "firstof",
        repeat1($.filtered_value),
        optional(spaced($._before_as, "as", $.identifier)),
      ),
    for_scope: ($) =>
      prec.left(
        seq(
          block(
            "for",
            field("variable", $.identifier),
            repeat(seq(",", field("variable", $.identifier))),
            "in",
            $.filtered_value,
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
        block("if", $.predicate),
        optional($.template),
        repeat(seq(block("elif", $.predicate), optional($.template))),
        optional(seq(block("else"), optional($.template))),
        block("endif"),
      ),
    ifchanged_group: ($) =>
      seq(
        block("ifchanged", repeat($.filtered_value)),
        optional($.template),
        block("endifchanged"),
      ),
    include: ($) => block("include", $.filtered_value),
    library: ($) =>
      prec(
        -1,
        seq($.identifier, optional(seq(token.immediate("."), $.identifier))),
      ),
    load: ($) =>
      block(
        "load",
        choice(
          seq(repeat1($.identifier), "from", $.library),
          repeat1($.library),
        ),
      ),
    lorem: ($) =>
      block(
        "lorem",
        $.filtered_value,
        choice(
          spaced($._before_w, "w"),
          spaced($._before_p, "p"),
          spaced($._before_b, "b"),
        ),
        optional(spaced($._before_random, "random")),
      ),
    now: ($) =>
      block(
        "now",
        $.string,
        optional(spaced($._before_as, "as", field("name", $.identifier))),
      ),
    partial: ($) => block("partial", $.identifier),
    partialdef_group: ($) =>
      seq(
        block("partialdef", $.push_partial, optional("inline")),
        optional($.template),
        block("endpartialdef", $.pop_partial),
      ),
    query_string: ($) =>
      block(
        "querystring",
        repeat($.identifier),
        repeat(seq($.identifier, "=", $.filtered_value)),
      ),
    regroup: ($) =>
      block(
        "regroup",
        $.filtered_value,
        spaced($._before_by, "by"),
        $.attribute,
        optional(spaced($._before_as, "as", field("variable", $.identifier))),
      ),
    reset_cycle: ($) => block("resetcycle", optional($.identifier)),
    spaceless_group: ($) =>
      seq(block("spaceless"), optional($.template), block("endspaceless")),
    template_tag_block: ($) =>
      block(
        "templatetag",
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
    url_block: ($) =>
      block(
        "url",
        choice($.string, $.identifier),
        optional(
          choice(
            repeat1($.filtered_value),
            repeat1(seq($.identifier, "=", $.filtered_value)),
          ),
        ),
        optional(spaced($._before_as, "as", field("variable", $.identifier))),
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
        $.filtered_value,
        $.filtered_value,
        $.filtered_value,
        optional(spaced($._before_as, "as", field("variable", $.identifier))),
      ),
    with_group: ($) =>
      seq(
        block(
          "with",
          repeat1(seq(field("variable", $.identifier), "=", $.filtered_value)),
        ),
        optional($.template),
        block("endwith"),
      ),
  },
});

export default django;
