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
 *
 * The pattern is the hidden rule _sep, which SEP refers to, rather than a regex
 * written inline, so that a grammar extending this one can write $._sep and
 * share the one token instead of repeating the pattern.
 */
const SEP = sym("_sep");

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
 * @param {RuleOrLiteral} name
 * @param {...RuleOrLiteral} args
 * @returns {SeqRule}
 */
function tag(name, ...args) {
  return seq(
    sym("simpleTagOpen"),
    field("tag_name", name),
    ...args,
    sym("simpleTagClose"),
  );
}

/**
 * The tags of a tag group. The scanner keeps a stack of the groups that are
 * open, which is what lets it tell a missing end tag from one that belongs to
 * the group, and it knows no group by name: every tag begins with
 * one of the opens (simpleTagOpen for a tag outside any group), whose zero-width token reads the tag's name to
 * the scanner, and the end of the tag says what that name means.
 *
 * - startTag: a tag that opens a group, which pushes one expecting "end"
 *   followed by the tag's name.
 * - followTag: a middle tag a group may hold only once, such as "else". The
 *   first belongs to the innermost group; a second, once that group already
 *   holds one, cannot be its own, so the innermost group is taken to be missing
 *   its end tag and the tag goes to a group around it.
 * - repeatTag: a middle tag a group may hold any number of times, such as
 *   "elif", which always belongs to the innermost group.
 * - endTag: the tag that closes the innermost group, which pops it.
 *
 * The ten utilities are inline rules rather than helpers, so that a grammar
 * extending this one can build its own groups from them; every tag it adds has
 * to begin with one of the opens, since the token they read with is valid
 * wherever a tag's name is and always wins.
 *
 * @param {RuleOrLiteral} name
 * @param {RuleOrLiteral[]} args
 * @returns {SeqRule}
 */
function startTag(name, ...args) {
  return seq(
    sym("startTagOpen"),
    field("tag_name", name),
    ...args,
    sym("startTagClose"),
  );
}

/**
 * @param {RuleOrLiteral} name
 * @param {RuleOrLiteral[]} args
 * @returns {SeqRule}
 */
function followTag(name, ...args) {
  return seq(
    sym("followTagOpen"),
    field("tag_name", name),
    ...args,
    sym("followTagClose"),
  );
}

/**
 * @param {RuleOrLiteral} name
 * @param {RuleOrLiteral[]} args
 * @returns {SeqRule}
 */
function repeatTag(name, ...args) {
  return seq(
    sym("repeatTagOpen"),
    field("tag_name", name),
    ...args,
    sym("repeatTagClose"),
  );
}

/**
 * @param {RuleOrLiteral} name
 * @param {RuleOrLiteral[]} args
 * @returns {SeqRule}
 */
function endTag(name, ...args) {
  return seq(
    sym("endTagOpen"),
    field("tag_name", name),
    ...args,
    sym("endTagClose"),
  );
}

/**
 * The "as name" clause that binds a tag's result in the context. Django spells
 * it the same way in every tag that takes one, so the grammar names the target
 * the same way too, matching the bindings in "for" and "with".
 */
const asVariable = part("as", field("variable", sym("identifier")));

/**
 * A tag's own keyword written where a value goes, with the tree an ordinary
 * lookup would have so that a tool sees no difference. Where a keyword and an
 * identifier are both valid, tree-sitter hands the parser the keyword, so the
 * reading in which the word names a variable has to be built back out of it —
 * and out of hidden rules, because an alias only renames the node its rule
 * makes and cannot nest one inside another.
 *
 * Django tells such a keyword from a variable by comparing the whole bit, so
 * "reversed" is its flag while "reversed.x" and "reversed|last" are lookups.
 * That second group is what `continued` selects.
 *
 * @param {string} word
 * @returns {Record<string, RuleBuilder<string>>}
 */
function wordAsValueRules(word) {
  return {
    [`_${word}_lookup`]: ($) => alias(word, $.identifier),
    [`_${word}_dotted_lookup`]: ($) =>
      seq(alias(word, $.identifier), ".", $.attribute),
    [`_${word}_value`]: ($) =>
      alias($[`_${word}_lookup`], $.variable_attribute),
    [`_${word}_dotted_value`]: ($) =>
      alias($[`_${word}_dotted_lookup`], $.variable_attribute),
    [`_${word}_bare`]: ($) => alias($[`_${word}_value`], $.value),
    [`_${word}_continued`]: ($) =>
      choice(
        seq(
          alias($[`_${word}_dotted_value`], $.value),
          optional(seq("|", $.filter_expression)),
        ),
        seq(alias($[`_${word}_value`], $.value), "|", $.filter_expression),
      ),
  };
}

/**
 * The rules wordAsValueRules() built, where a value goes.
 * @param {string} word
 * @param {boolean} continued whether a "." or a "|" has to follow the word
 * @returns {RuleOrLiteral}
 */
function wordAsValue(word, continued) {
  return alias(
    sym(`_${word}_${continued ? "continued" : "bare"}`),
    sym("filtered_value"),
  );
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
 * @param {boolean|number} args how many positional arguments the signature
 *   takes: true for any number (*args), a count for at most that many, or
 *   false for none
 * @param {boolean|Record<string, RuleOrLiteral>} kwargs true for any
 *   "name=value" pair (**kwargs), false for none, or the accepted names mapped
 *   to their value rules, each of which may be given at most once
 * @param {RuleOrLiteral} name
 * @returns {SeqRule}
 */
function simpleTag(name, args = true, kwargs = true) {
  const parts = [];
  if (args === true) {
    parts.push(repeat(part(sym("filtered_value"))));
  } else if (typeof args === "number" && args > 0) {
    // at most `args` of them, so each further one nests inside the last
    let rule = part(sym("filtered_value"));
    for (let i = 1; i < args; ++i) {
      rule = seq(part(sym("filtered_value")), optional(rule));
    }
    parts.push(optional(rule));
  }
  if (kwargs === true) {
    // parse_bits refuses a keyword argument the tag already holds, whatever
    // **kwargs it takes, so the scanner keeps the names rather than the grammar
    parts.unshift(sym("_tag_open"));
    parts.push(
      repeat(
        part(
          seq(
            sym("_kwarg_name"),
            sym("identifier"),
            "=",
            sym("filtered_value"),
          ),
        ),
      ),
    );
  } else if (kwargs) {
    parts.unshift(sym("_tag_open"));
    // a known signature: any of the names it accepts, in any order, none twice
    const named = Object.entries(kwargs).map(([name, value]) =>
      part(seq(sym("_kwarg_name"), name, "=", value)),
    );
    // a name the signature does not take is flagged in place
    const unexpected = part(
      seq(
        sym("_kwarg_name"),
        alias(sym("_unexpected_keyword"), sym("unexpected_argument")),
      ),
    );
    parts.push(repeat(choice(...named, unexpected)));
  }
  return tag(name, ...parts, optional(asVariable));
}

/**
 * The rules of one spelling of blocktranslate, which Django registers under
 * both "blocktrans" and "blocktranslate" and closes with the matching end tag.
 * Only the counted form takes a plural, so the block has to know which
 * opening tag it saw: the two forms are separate hidden rules, each aliased
 * to the one visible <name>_tag where the block uses it.
 *
 * @param {string} name
 * @returns {Record<string, RuleBuilder<string>>}
 */
function blocktransRules(name) {
  return {
    [`_${name}_tag`]: ($) =>
      startTag(name, $._tag_open, repeat($._translate_option)),
    [`_${name}_count_tag`]: ($) =>
      startTag(
        name,
        $._tag_open,
        repeat($._translate_option),
        $._translate_count,
        repeat($._translate_option),
      ),
    [`${name}_block`]: ($) =>
      choice(
        seq(
          alias($[`_${name}_tag`], $[`${name}_tag`]),
          optional($._translate_body),
        ),
        seq(
          alias($[`_${name}_count_tag`], $[`${name}_tag`]),
          optional($._translate_body),
          choice($.plural_block, alias($._missing_tag, $.missing_plural_tag)),
        ),
      ),
    [`end${name}_tag`]: ($) => endTag(`end${name}`),
  };
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

/**
 * The names the scanner's marker takes where a tag group's required tag is
 * missing, each named for the tag it stands in for. The scanner has one marker
 * token, aliased to these at each use, so that every body accepts the same
 * external tokens: tree-sitter will not merge states that differ in them, and a
 * token per group made the parse table ten times the size.
 *
 * A marker is placed only at the end of input, before a tag whose name is
 * reserved to some other group, or before an endblock or endpartialdef whose
 * name closes a tag further out; the group then closes with no ERROR, and
 * queries/errors.scm lists these names to report it. They are not a supertype:
 * the generator drops a supertype whose members are aliases.
 */
const MISSING_TAGS = [
  "missing_endautoescape_tag",
  "missing_endblock_tag",
  "missing_endblocktrans_tag",
  "missing_endblocktranslate_tag",
  "missing_endcache_tag",
  "missing_endcomment_tag",
  "missing_endfilter_tag",
  "missing_endfor_tag",
  "missing_endif_tag",
  "missing_endifchanged_tag",
  "missing_endlanguage_tag",
  "missing_endlocalize_tag",
  "missing_endlocaltime_tag",
  "missing_endpartialdef_tag",
  "missing_endspaceless_tag",
  "missing_endtimezone_tag",
  "missing_endverbatim_tag",
  "missing_endwith_tag",
  "missing_plural_tag",
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
    [$.autoescape_block],
    [$.block_block],
    [$.cache_block],
    [$.elif_block],
    [$.else_block],
    [$.empty_block],
    [$.filter_block],
    [$.for_block],
    [$.if_block],
    [$.ifchanged_block],
    [$.language_block],
    [$.localize_block],
    [$.localtime_block],
    [$.partialdef_block],
    [$.spaceless_block],
    [$.timezone_block],
    [$.with_block],
    [$.binaryOperator],
    [$.predicate],
    [$._translate_option],
    [$.unexpected_argument],
    [$.variable_attribute, $._unexpected_word],
    [$.resetcycle_tag, $._unexpected_word],
    [$.library, $._unexpected_word],
    [$.library, $.load_tag],
    [$._filtered_value_spaced],
    [$._filter_expression_spaced],
  ],
  // the tags of a group; see startTag
  inline: ($) => [
    $.simpleTagOpen,
    $.simpleTagClose,
    $.startTagOpen,
    $.startTagClose,
    $.followTagOpen,
    $.followTagClose,
    $.repeatTagOpen,
    $.repeatTagClose,
    $.endTagOpen,
    $.endTagClose,
  ],
  supertypes: ($) => [$.template_node, $.template_tag],
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
    $._missing_tag,
    $._group_open_tag_read,
    $._group_open_tag_push,
    $._group_follow,
    $._group_repeat,
    $._group_close,
    $._group_held,
    $._text_brace,
  ],
  reserved: {
    global: ($) => ["not", "if", "in", "is", "as", "for", "from"],
    group_tag_names: ($) => NAMES_INSIDE_A_TAG_GROUP,
  },
  rules: {
    template: ($) => repeat1(choice($.template_node, $.content)),
    // the tags of a group; see startTag
    simpleTagOpen: ($) => seq("{%", $._group_open_tag_read, optional(SEP)),
    simpleTagClose: ($) =>
      seq(optional($.unexpected_argument), optional(SEP), "%}"),
    startTagOpen: ($) => seq("{%", $._group_open_tag_read, optional(SEP)),
    startTagClose: ($) =>
      seq(
        optional($.unexpected_argument),
        $._group_open_tag_push,
        optional(SEP),
        "%}",
      ),
    followTagOpen: ($) => seq("{%", $._group_open_tag_read, optional(SEP)),
    followTagClose: ($) =>
      seq(
        optional($.unexpected_argument),
        $._group_follow,
        optional(SEP),
        "%}",
      ),
    repeatTagOpen: ($) => seq("{%", $._group_open_tag_read, optional(SEP)),
    repeatTagClose: ($) =>
      seq(
        optional($.unexpected_argument),
        $._group_repeat,
        optional(SEP),
        "%}",
      ),
    endTagOpen: ($) => seq("{%", $._group_open_tag_read, optional(SEP)),
    endTagClose: ($) =>
      seq(optional($.unexpected_argument), $._group_close, optional(SEP), "%}"),
    content: ($) => prec.right(repeat1(choice($._text, $._text_brace))),
    /**
     * Template text up to a "{{", "{%" or "{#". A "{" that is text only because
     * of what comes after the next character, as in "a{{% if x %}" or a "{" at
     * the end of input, is _text_brace from the scanner; see
     * scan_text_brace_rest.
     */
    _text: ($) => /(?:[^\{]|\{[^\{#%])+/,
    // the separator between the parts of a tag; see SEP
    _sep: ($) => /[ \t\r\n]+/,
    template_node: ($) =>
      choice($.template_tag, $.template_variable, $.template_comment),
    filtered_value: ($) =>
      seq($.value, optional(seq("|", $.filter_expression))),
    filter_expression: ($) => seq($.filter, repeat(seq("|", $.filter))),
    value: ($) => choice($.literal, $.variable_attribute),
    literal: ($) =>
      choice($.number, $.string, $.translated_string, $.boolean, $.none),
    /**
     * Digits, with single underscores allowed between them, as Python's int()
     * and float() accept ("1_000") and Django's Variable relies on.
     *
     * A trailing dot needs an exponent after it. Variable calls float() and
     * then rejects what it just parsed if the last character is a dot — the
     * comment in Django reads `# "2." is invalid` — so "1." is a two-part
     * lookup there rather than a number, while "1.e5" is a float.
     */
    number: ($) =>
      /[-+]?(?:(?:[0-9](?:_?[0-9])*(?:\.[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*)(?:[eE][0-9](?:_?[0-9])*)?|[0-9](?:_?[0-9])*\.[eE][0-9](?:_?[0-9])*)/,
    string: ($) => STRING,
    /**
     * A string to translate at render time. Django matches "_(" and ")" as
     * part of the constant itself, so nothing may come between them and the
     * string: "_( 'a' )" is a syntax error there, not a translated literal.
     */
    translated_string: ($) => seq("_(", $.string, ")"),
    // the flags of "for" and "trans", spelled as the variable names they
    // also are; see wordAsValueRules()
    ...wordAsValueRules("reversed"),
    ...wordAsValueRules("noop"),
    boolean: ($) => choice("True", "False"),
    none: ($) => "None",
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
        prec.dynamic(1, joined("not", "in")),
        "is",
        prec.dynamic(1, joined("is", "not")),
      ),
    predicate: ($) =>
      seq(
        repeat(seq("not", SEP)),
        $.filtered_value,
        repeat(
          seq(
            part($.binaryOperator),
            repeat(part("not")),
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
    template_tag: ($) =>
      choice(
        $.autoescape_group,
        $.block_group,
        $.blocktranslate_group,
        $.cache_group,
        $.comment_group,
        $.csp_nonce_attr_tag,
        $.csrf_token_tag,
        $.custom_tag,
        $.cycle_tag,
        $.debug_tag,
        $.extends_tag,
        $.filter_group,
        $.firstof_tag,
        $.for_group,
        $.get_available_languages_tag,
        $.get_current_language_tag,
        $.get_current_language_bidi_tag,
        $.get_current_timezone_tag,
        $.get_language_info_tag,
        $.get_language_info_list_tag,
        $.get_media_prefix_tag,
        $.get_static_prefix_tag,
        $.if_group,
        $.ifchanged_group,
        $.include_tag,
        $.language_group,
        $.load_tag,
        $.localize_group,
        $.localtime_group,
        $.lorem_tag,
        $.now_tag,
        $.partial_tag,
        $.partialdef_group,
        $.querystring_tag,
        $.regroup_tag,
        $.resetcycle_tag,
        $.spaceless_group,
        $.static_tag,
        $.templatetag_tag,
        $.timezone_group,
        $.translate_tag,
        $.unexpected_tag,
        $.url_tag,
        $.verbatim_group,
        $.widthratio_tag,
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
          "filter_name",
          choice(
            ...FILTERS_WITHOUT_ARGUMENT,
            ...I18N_FILTERS_WITHOUT_ARGUMENT,
            ...L10N_FILTERS_WITHOUT_ARGUMENT,
            ...TZ_FILTERS_WITHOUT_ARGUMENT,
          ),
        ),
        seq(
          field(
            "filter_name",
            choice(...FILTERS_WITH_ARGUMENT, ...TZ_FILTERS_WITH_ARGUMENT),
          ),
          ":",
          field("argument", $.value),
        ),
        seq(
          field("filter_name", choice(...FILTERS_WITH_OPTIONAL_ARGUMENT)),
          optional(seq(":", field("argument", $.value))),
        ),
        $._custom_filter,
      ),
    /**
     * A filter a "load" brought in: its name is not known here, and so neither
     * is whether it takes an argument. Hidden, so the tree is the same as if
     * it were spelled inline, but named so that a grammar extending this one
     * can drop it from filter's alternatives the way it can drop custom_tag
     * from template_tag.
     */
    _custom_filter: ($) =>
      seq(
        field("filter_name", $.identifier),
        optional(seq(":", field("argument", $.value))),
      ),
    autoescape_tag: ($) => startTag("autoescape", part(choice("on", "off"))),
    autoescape_block: ($) => seq($.autoescape_tag, optional($.template)),
    endautoescape_tag: ($) => endTag("endautoescape"),
    autoescape_group: ($) =>
      seq(
        $.autoescape_block,
        choice(
          $.endautoescape_tag,
          alias($._missing_tag, $.missing_endautoescape_tag),
        ),
      ),
    // the scanner takes the whitespace before a name it has to match itself
    block_tag: ($) => startTag("block", field("name", $.push_block)),
    block_block: ($) => seq($.block_tag, optional($.template)),
    endblock_tag: ($) => endTag("endblock", $.pop_block),
    block_group: ($) =>
      seq(
        $.block_block,
        choice($.endblock_tag, alias($._missing_tag, $.missing_endblock_tag)),
      ),
    plural_tag: ($) => followTag("plural"),
    plural_block: ($) => seq($.plural_tag, optional($._translate_body)),
    ...blocktransRules("blocktrans"),
    ...blocktransRules("blocktranslate"),
    blocktranslate_group: ($) =>
      choice(
        seq(
          $.blocktrans_block,
          choice(
            $.endblocktrans_tag,
            alias($._missing_tag, $.missing_endblocktrans_tag),
          ),
        ),
        seq(
          $.blocktranslate_block,
          choice(
            $.endblocktranslate_tag,
            alias($._missing_tag, $.missing_endblocktranslate_tag),
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
          // asvar names where the rendered text is stored, which is read
          // after the block rather than inside it, so it is not a binding of
          // the block the way "with" and "count" are
          part("asvar", field("asvar", $.identifier)),
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
     * these. Django lets a name repeat — token_kwargs builds a dict and the
     * later value simply wins — but writing one twice has no use and is taken
     * here to be a mistake, so the scanner guards these too.
     */
    _tag_kwargs: ($) =>
      repeat1(
        part(
          seq(
            $._kwarg_name,
            field("variable", $.identifier),
            "=",
            $.filtered_value,
          ),
        ),
      ),
    cache_tag: ($) =>
      startTag(
        "cache",
        part($.filtered_value),
        part(choice($.identifier, $.string)),
        repeat(part($.filtered_value)),
        optional(part(seq("using=", $.filtered_value))),
      ),
    cache_block: ($) => seq($.cache_tag, optional($.template)),
    endcache_tag: ($) => endTag("endcache"),
    cache_group: ($) =>
      seq(
        $.cache_block,
        choice($.endcache_tag, alias($._missing_tag, $.missing_endcache_tag)),
      ),
    comment_tag: ($) => startTag("comment", optional(part($.string))),
    comment_block: ($) => seq($.comment_tag, optional($.comment_content)),
    endcomment_tag: ($) => endTag("endcomment"),
    comment_group: ($) =>
      seq(
        $.comment_block,
        choice(
          $.endcomment_tag,
          alias($._missing_tag, $.missing_endcomment_tag),
        ),
      ),
    // csp_nonce_attr(context, media=None)
    csp_nonce_attr_tag: ($) =>
      simpleTag("csp_nonce_attr", 1, { media: $.filtered_value }),
    csrf_token_tag: ($) => tag("csrf_token"),
    /**
     * A tag a "load" brought in. Its arguments cannot be known here, so what
     * is accepted is what Library.simple_tag and Library.inclusion_tag take,
     * which is how a tag is registered unless it needs the parser itself.
     */
    custom_tag: ($) => simpleTag(reserved("group_tag_names", $.identifier)),
    cycle_tag: ($) =>
      tag(
        "cycle",
        repeat1(part($.filtered_value)),
        optional(
          seq(
            asVariable,
            // only the as-form takes the flag
            optional(part("silent")),
          ),
        ),
      ),
    debug_tag: ($) => tag("debug"),
    extends_tag: ($) => tag("extends", part($.filtered_value)),
    // the filter tag hands Django the rest of its text as one expression rather
    // than as split arguments, so pipes here take whitespace just as they do
    // between "{{" and "}}"
    filter_tag: ($) =>
      startTag(
        "filter",
        part(alias($._filter_expression_spaced, $.filter_expression)),
      ),
    filter_block: ($) => seq($.filter_tag, optional($.template)),
    endfilter_tag: ($) => endTag("endfilter"),
    filter_group: ($) =>
      seq(
        $.filter_block,
        choice($.endfilter_tag, alias($._missing_tag, $.missing_endfilter_tag)),
      ),
    firstof_tag: ($) =>
      tag("firstof", repeat1(part($.filtered_value)), optional(asVariable)),
    for_tag: ($) =>
      startTag(
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
        // do_for reads the flag off the end and takes the sequence from the
        // bit before it, so the flag comes last or not at all. A bare
        // "reversed" in the sequence position leaves nothing to iterate,
        // naming a sequence only when a lookup or filter continues it or
        // when the flag follows it as well
        choice(
          seq(part($.filtered_value), optional(part("reversed"))),
          seq(part(wordAsValue("reversed", true)), optional(part("reversed"))),
          seq(part(wordAsValue("reversed", false)), part("reversed")),
        ),
      ),
    for_block: ($) => seq($.for_tag, optional($.template)),
    empty_tag: ($) => followTag("empty"),
    empty_block: ($) => seq($.empty_tag, optional($.template)),
    endfor_tag: ($) => endTag("endfor"),
    for_group: ($) =>
      seq(
        $.for_block,
        optional($.empty_block),
        choice($.endfor_tag, alias($._missing_tag, $.missing_endfor_tag)),
      ),
    /**
     * django.templatetags.i18n. Each of these requires exactly "as <name>",
     * or "for <expression> as <name>", and rejects anything further.
     */
    get_available_languages_tag: ($) =>
      tag("get_available_languages", asVariable),
    get_current_language_tag: ($) => tag("get_current_language", asVariable),
    get_current_language_bidi_tag: ($) =>
      tag("get_current_language_bidi", asVariable),
    get_language_info_tag: ($) =>
      tag("get_language_info", part("for", $.filtered_value), asVariable),
    get_language_info_list_tag: ($) =>
      tag("get_language_info_list", part("for", $.filtered_value), asVariable),
    /**
     * django.templatetags.tz. get_current_timezone_tag requires exactly
     * "as <name>", so unlike get_static_prefix the clause is not optional and
     * nothing may follow it.
     */
    get_current_timezone_tag: ($) => tag("get_current_timezone", asVariable),
    get_media_prefix_tag: ($) => tag("get_media_prefix", optional(asVariable)),
    get_static_prefix_tag: ($) =>
      tag("get_static_prefix", optional(asVariable)),
    if_tag: ($) => startTag("if", part($.predicate)),
    if_block: ($) => seq($.if_tag, optional($.template)),
    elif_tag: ($) => repeatTag("elif", part($.predicate)),
    elif_block: ($) => seq($.elif_tag, optional($.template)),
    /** Shared by if_group and ifchanged_group, which spell it the same way. */
    else_tag: ($) => followTag("else"),
    else_block: ($) => seq($.else_tag, optional($.template)),
    endif_tag: ($) => endTag("endif"),
    if_group: ($) =>
      seq(
        $.if_block,
        repeat($.elif_block),
        optional($.else_block),
        choice($.endif_tag, alias($._missing_tag, $.missing_endif_tag)),
      ),
    ifchanged_tag: ($) => startTag("ifchanged", repeat(part($.filtered_value))),
    ifchanged_block: ($) => seq($.ifchanged_tag, optional($.template)),
    endifchanged_tag: ($) => endTag("endifchanged"),
    ifchanged_group: ($) =>
      seq(
        $.ifchanged_block,
        optional($.else_block),
        choice(
          $.endifchanged_tag,
          alias($._missing_tag, $.missing_endifchanged_tag),
        ),
      ),
    /**
     * do_include takes "with" and "only" in either order and refuses one it has
     * already been given, and "with" needs at least one argument. It calls
     * token_kwargs with support_legacy=False, so "{% include "t" with a as b %}"
     * is an error here as it is there, unlike the same clause in "{% with %}".
     */
    include_tag: ($) =>
      tag(
        "include",
        $._tag_open,
        part($.filtered_value),
        optional(
          arrangements([seq(part("with"), $._tag_kwargs), part("only")]),
        ),
      ),
    /** django.templatetags.i18n. The language tag takes the one argument. */
    language_tag: ($) => startTag("language", part($.filtered_value)),
    language_block: ($) => seq($.language_tag, optional($.template)),
    endlanguage_tag: ($) => endTag("endlanguage"),
    language_group: ($) =>
      seq(
        $.language_block,
        choice(
          $.endlanguage_tag,
          alias($._missing_tag, $.missing_endlanguage_tag),
        ),
      ),
    library: ($) => seq($.identifier, optional(seq(".", $.identifier))),
    load_tag: ($) =>
      tag(
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
    localize_tag: ($) =>
      startTag("localize", optional(part(choice("on", "off")))),
    localize_block: ($) => seq($.localize_tag, optional($.template)),
    endlocalize_tag: ($) => endTag("endlocalize"),
    localize_group: ($) =>
      seq(
        $.localize_block,
        choice(
          $.endlocalize_tag,
          alias($._missing_tag, $.missing_endlocalize_tag),
        ),
      ),
    /** django.templatetags.tz, taking "on" or "off" as localize does. */
    localtime_tag: ($) =>
      startTag("localtime", optional(part(choice("on", "off")))),
    localtime_block: ($) => seq($.localtime_tag, optional($.template)),
    endlocaltime_tag: ($) => endTag("endlocaltime"),
    localtime_group: ($) =>
      seq(
        $.localtime_block,
        choice(
          $.endlocaltime_tag,
          alias($._missing_tag, $.missing_endlocaltime_tag),
        ),
      ),
    lorem_tag: ($) =>
      tag(
        "lorem",
        part($.filtered_value),
        part(choice("w", "p", "b")),
        optional(part("random")),
      ),
    now_tag: ($) => tag("now", part($.string), optional(asVariable)),
    partial_tag: ($) => tag("partial", part($.identifier)),
    partialdef_tag: ($) =>
      startTag("partialdef", $.push_partial, optional(part("inline"))),
    partialdef_block: ($) => seq($.partialdef_tag, optional($.template)),
    endpartialdef_tag: ($) => endTag("endpartialdef", $.pop_partial),
    partialdef_group: ($) =>
      seq(
        $.partialdef_block,
        choice(
          $.endpartialdef_tag,
          alias($._missing_tag, $.missing_endpartialdef_tag),
        ),
      ),
    // querystring(context, *args, **kwargs)
    querystring_tag: ($) => simpleTag("querystring"),
    regroup_tag: ($) =>
      tag(
        "regroup",
        part($.filtered_value),
        part("by"),
        part($.attribute),
        optional(asVariable),
      ),
    resetcycle_tag: ($) => tag("resetcycle", optional(part($.identifier))),
    spaceless_tag: ($) => startTag("spaceless"),
    spaceless_block: ($) => seq($.spaceless_tag, optional($.template)),
    endspaceless_tag: ($) => endTag("endspaceless"),
    spaceless_group: ($) =>
      seq(
        $.spaceless_block,
        choice(
          $.endspaceless_tag,
          alias($._missing_tag, $.missing_endspaceless_tag),
        ),
      ),
    static_tag: ($) =>
      tag("static", part($.filtered_value), optional(asVariable)),
    templatetag_tag: ($) =>
      tag(
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
    timezone_tag: ($) => startTag("timezone", part($.filtered_value)),
    timezone_block: ($) => seq($.timezone_tag, optional($.template)),
    endtimezone_tag: ($) => endTag("endtimezone"),
    timezone_group: ($) =>
      seq(
        $.timezone_block,
        choice(
          $.endtimezone_tag,
          alias($._missing_tag, $.missing_endtimezone_tag),
        ),
      ),
    /**
     * django.templatetags.i18n, registered under both spellings. do_translate
     * pops its options off one at a time and refuses one it has already seen,
     * so they may be written in any order but none of them twice.
     */
    translate_tag: ($) =>
      tag(
        choice("trans", "translate"),
        part($.filtered_value),
        optional(
          arrangements([
            part("noop"),
            // do_translate refuses "as" and "noop" as the context, comparing
            // the whole bit, so a lookup that only begins with one is fine
            part(
              "context",
              choice($.filtered_value, wordAsValue("noop", true)),
            ),
            asVariable,
          ]),
        ),
      ),
    /**
     * A tag of some group, written where no open group can hold it: an end tag
     * with nothing open, or a middle tag the innermost group does not take. It
     * is a node of its own rather than an ERROR so that error recovery has
     * nothing to repair: recovery rewinds to just after the "{%" every tag
     * starts with, and folds the stray tag into whichever tag comes next.
     * Dynamic precedence keeps it from displacing a tag its group does take,
     * and queries/errors.scm reports it.
     *
     * Of several tags with a name the group may hold only once, such as a
     * second and a third "else", the later ones are the strays. Reading the
     * first as the stray instead parses just as well, so _group_held, which the
     * scanner returns only for a name the innermost group already holds, puts
     * the later reading at -2 against -4 for each tag flagged before its time. Both
     * cost more than an unexpected_argument, at -1, so a tag its group does take
     * but with a word it does not is read as that tag rather than as a stray.
     */
    unexpected_tag: ($) =>
      choice(
        prec.dynamic(
          -2,
          seq(
            $.simpleTagOpen,
            field("tag_name", choice(...NAMES_INSIDE_A_TAG_GROUP)),
            optional($.unexpected_argument),
            $._group_held,
            optional(SEP),
            "%}",
          ),
        ),
        prec.dynamic(
          -4,
          seq(
            $.simpleTagOpen,
            field("tag_name", choice(...NAMES_INSIDE_A_TAG_GROUP)),
            $.simpleTagClose,
          ),
        ),
      ),
    /**
     * Words a tag does not take, kept inside the tag they were written in. Every
     * close utility accepts them before its "%}", so a misused tag keeps its own
     * node, "{% else x %}" is still the else of its group, and error recovery
     * has nothing to repair. queries/errors.scm reports it.
     */
    unexpected_argument: ($) => repeat1($._unexpected_word),
    /**
     * One word of an unexpected_argument, costing -1 of dynamic precedence of
     * its own, so that a reading flagging more words than it must always loses:
     * "{% cycle a b as x silent zqx %}" flags zqx, not everything after a.
     *
     * The word is a token of lexical precedence -1, so that a token an argument
     * really takes wins wherever one is valid, even over a longer match:
     * "b|upper" is still a filtered value. Where a keyword is valid, as after
     * "{% for a in b" where "reversed" may follow, tree-sitter lexes every word
     * as an identifier to check for the keyword, so an identifier is a word
     * here too, followed by whatever touches it ("a=2", "x.y|upper"). It is
     * aliased so that queries/locals.scm does not take it for a reference.
     */
    _unexpected_word: ($) =>
      prec.dynamic(
        -1,
        seq(
          SEP,
          choice(
            token(prec(-1, /[^\s%]+/)),
            seq(
              alias($.identifier, "unexpected_word"),
              optional(token.immediate(prec(-1, /[^\s%]+/))),
            ),
          ),
        ),
      ),
    /**
     * A "name=value" argument whose name a tag with a known signature does not
     * take. The scanner's _kwarg_name reads any name followed by "=", which
     * commits the parser to a keyword argument before the name is known, so
     * the name the signature lacks is taken here rather than after the tag.
     */
    _unexpected_keyword: ($) =>
      prec.dynamic(
        -1,
        seq(
          alias($.identifier, "unexpected_word"),
          token.immediate(prec(-1, /[^\s%]+/)),
        ),
      ),
    url_tag: ($) =>
      tag(
        "url",
        part(choice($.string, $.identifier)),
        optional(
          choice(
            repeat1(part($.filtered_value)),
            repeat1(part(seq($.identifier, "=", $.filtered_value))),
          ),
        ),
        optional(asVariable),
      ),
    verbatim_tag: ($) => startTag("verbatim", $.push_verbatim),
    verbatim_block: ($) => seq($.verbatim_tag, optional($.verbatim_content)),
    endverbatim_tag: ($) => endTag("endverbatim", $.pop_verbatim),
    verbatim_group: ($) =>
      seq(
        $.verbatim_block,
        choice(
          $.endverbatim_tag,
          alias($._missing_tag, $.missing_endverbatim_tag),
        ),
      ),
    widthratio_tag: ($) =>
      tag(
        "widthratio",
        part($.filtered_value),
        part($.filtered_value),
        part($.filtered_value),
        optional(asVariable),
      ),
    with_tag: ($) => startTag("with", $._tag_open, $._tag_kwargs),
    with_block: ($) => seq($.with_tag, optional($.template)),
    endwith_tag: ($) => endTag("endwith"),
    with_group: ($) =>
      seq(
        $.with_block,
        choice($.endwith_tag, alias($._missing_tag, $.missing_endwith_tag)),
      ),
  },
});

export default django;
