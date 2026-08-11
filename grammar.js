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

const django = grammar({
  name: "django",
  extras: ($) => [/[ \t]/],
  conflicts: ($) => [[$.template]],
  supertypes: ($) => [$.template_tag, $.template_block_groups],
  externals: ($) => [
    $.pop_block,
    $.pop_partial,
    $.pop_verbatim,
    $.push_block,
    $.push_partial,
    $.push_verbatim,
    $.verbatim_content,
    $.comment_content,
    $.matcher_error,
  ],
  reserved: {
    global: ($) => ["not", "if", "in", "is", "as"],
  },
  rules: {
    template: ($) => repeat1(choice($.template_tag, $.content)),
    content: ($) => /(?:[^\{]|\{[^\{#%}])+/,
    template_tag: ($) => choice($.template_block_groups, $.template_variable, $.template_comment),
    filtered_value: ($) => seq(
      $.value,
      optional(
        seq(
          token.immediate("|"),
          $.filter_expression
        ),
      ),
    ),
    filter_expression: ($) => seq($.filter, repeat(seq(token.immediate("|"), $.filter))),
    value: ($) => choice($.literal, $.variable_attribute),
    literal: ($) => choice($.number, $.string),
    number: ($) => /-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]-?[0-9]+)?/,
    string: ($) => /"(?:[^"\\]|\\\\|\\")*"|'(?:[^'\\]|\\\\|\\')*'/,
    attribute: ($) => /[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*/,
    variable_attribute: ($) => seq($.identifier, optional(seq(token.immediate('.'), $.attribute))),
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
        prec(1, seq("not", "in")),
        "is",
        prec(1, seq("is", "not"))
      ),
    predicate: ($) =>
      seq(
        optional("not"),
        $.filtered_value,
        repeat(seq($.binaryOperator, optional("not"), $.filtered_value))
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
        $.with_group
      ),
    filter: ($) => choice(
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
      seq(block("autoescape", choice("on", "off")), optional($.template), block("endautoescape")),
    block_group: ($) =>
      seq(
        block("block", field("name", $.push_block)),
        optional($.template),
        block("endblock", $.pop_block)
      ),
    comment_group: ($) =>
      seq(
        block("comment", optional($.string)),
        optional($.comment_content),
        prec(1, block("endcomment"))
      ),
    csrf_token: ($) => block("csrf_token"),
    cycle: ($) =>
      block(
        "cycle",
        repeat1($.filtered_value),
        optional(seq("as", field("name", $.identifier))),
        optional("silent")
      ),
    debug: ($) => block("debug"),
    extends: ($) => block("extends", $.filtered_value),
    filter_group: ($) =>
      seq(block("filter", $.filter_expression), optional($.template), block("endfilter")),
    firstof: ($) => block("firstof", repeat1($.filtered_value), optional(seq("as", $.identifier))),
    for_group: ($) =>
      seq(
        block(
          "for",
          field("variables", $.identifier),
          repeat(seq(",", field("variables", $.identifier))),
          "in",
          $.filtered_value
        ),
        optional($.template),
        optional(seq(block("empty"), optional($.template))),
        block("endfor")
      ),
    if_group: ($) =>
      seq(
        block("if", $.predicate),
        optional($.template),
        repeat(seq(block("elif", $.predicate), optional($.template))),
        optional(seq(block("else"), optional($.template))),
        block("endif")
      ),
    ifchanged_group: ($) =>
      seq(
        block("ifchanged", repeat($.filtered_value)),
        optional($.template),
        block("endifchanged")
      ),
    include: ($) => block("include", $.filtered_value),
    load: ($) =>
      block(
        "load",
        choice(
          repeat1($.variable_attribute),
          seq(repeat1($.identifier), "from", $.variable_attribute)
        )
      ),
    lorem: ($) => block("lorem", $.filtered_value, choice("w", "p", "b"), optional("random")),
    now: ($) => block("now", $.string, optional(seq("as", field("variable", $.identifier)))),
    partial: ($) => block("partial", field("name", $.identifier)),
    partialdef_group: ($) =>
      seq(
        block("partialdef", field("name", $.push_partial), optional("inline")),
        optional($.template),
        block("endpartialdef", $.pop_partial)
      ),
    query_string: ($) =>
      block("querystring", repeat($.identifier), repeat(seq($.identifier, "=", $.filtered_value))),
    regroup: ($) =>
      block(
        "regroup",
        $.filtered_value,
        "by",
        $.attribute,
        optional(seq("as", field("variable", $.identifier)))
      ),
    reset_cycle: ($) => block("resetcycle", optional($.identifier)),
    spaceless_group: ($) => seq(block("spaceless"), optional($.template), block("endspaceless")),
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
          "closecomment"
        )
      ),
    url_block: $ => block(
      "url",
      choice($.string, $.identifier),
      optional(
        choice(
          repeat1($.filtered_value),
          repeat1(seq($.identifier, '=', $.filtered_value)),
        ),
      ),
      optional(
        seq("as", field("variable", $.identifier)),
      ),
    ),
    verbatim_group: ($) =>
      seq(
        block("verbatim", field("name", $.push_verbatim)),
        optional($.verbatim_content),
        block("endverbatim", $.pop_verbatim),
      ),
    with_group: ($) =>
      seq(
        block("with", field("variables", repeat1(seq(field("name", $.identifier), "=", $.filtered_value)))),
        optional($.template),
        block("endwith")
      ),
  },
});

export default django;
