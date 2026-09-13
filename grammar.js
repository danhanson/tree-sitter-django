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
 * A tag that opens or closes a tag group. The scanner keeps a stack of the
 * groups that are open, which is what lets it tell a missing end tag from one
 * that belongs to the group, so `marker` is a zero-width token placed before the
 * tag's name: the scanner reads the name ahead of the grammar to push or pop the
 * group. block, partialdef and verbatim push and pop through the tokens that
 * match their names instead.
 *
 * @param {Rule} marker
 * @param {RuleOrLiteral} tag
 * @param {RuleOrLiteral[]} args
 * @returns {SeqRule}
 */
function groupBlock(marker, tag, ...args) {
  return seq(
    "{%",
    optional(SEP),
    marker,
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
 * @param {GrammarSymbols<string>} $
 * @param {string} word
 * @param {boolean} continued whether a "." or a "|" has to follow the word
 * @returns {RuleOrLiteral}
 */
function wordAsValue($, word, continued) {
  return alias(
    $[`_${word}_${continued ? "continued" : "bare"}`],
    $.filtered_value,
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
 * The rules of one spelling of blocktranslate, which Django registers under
 * both "blocktrans" and "blocktranslate" and closes with the matching end tag.
 * Only the counted form takes a plural, so the clause has to know which
 * opening block it saw: the two forms are separate hidden rules, each aliased
 * to the one visible <tag>_block where the clause uses it.
 *
 * @param {string} tag
 * @returns {Record<string, RuleBuilder<string>>}
 */
function blocktransRules(tag) {
  return {
    [`_${tag}_block`]: ($) =>
      groupBlock($._group_open, tag, $._tag_open, repeat($._translate_option)),
    [`_${tag}_count_block`]: ($) =>
      groupBlock(
        $._group_open,
        tag,
        $._tag_open,
        repeat($._translate_option),
        $._translate_count,
        repeat($._translate_option),
      ),
    [`${tag}_clause`]: ($) =>
      choice(
        seq(
          alias($[`_${tag}_block`], $[`${tag}_block`]),
          optional($._translate_body),
        ),
        seq(
          alias($[`_${tag}_count_block`], $[`${tag}_block`]),
          optional($._translate_body),
          choice(
            $.plural_clause,
            alias($._missing_tag, $.missing_plural_block),
          ),
        ),
      ),
    [`end${tag}_block`]: ($) => groupBlock($._group_close, `end${tag}`),
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
 * an identifier and custom_tag_block accepts it: "{% endif %}" on its own parsed as
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
const MISSING_BLOCKS = [
  "missing_endautoescape_block",
  "missing_endblock_block",
  "missing_endblocktrans_block",
  "missing_endblocktranslate_block",
  "missing_endcache_block",
  "missing_endcomment_block",
  "missing_endfilter_block",
  "missing_endfor_block",
  "missing_endif_block",
  "missing_endifchanged_block",
  "missing_endlanguage_block",
  "missing_endlocalize_block",
  "missing_endlocaltime_block",
  "missing_endpartialdef_block",
  "missing_endspaceless_block",
  "missing_endtimezone_block",
  "missing_endverbatim_block",
  "missing_endwith_block",
  "missing_plural_block",
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
    [$.autoescape_clause],
    [$.block_clause],
    [$.cache_clause],
    [$.elif_clause],
    [$.else_clause],
    [$.empty_clause],
    [$.filter_clause],
    [$.for_clause],
    [$.if_clause],
    [$.ifchanged_clause],
    [$.language_clause],
    [$.localize_clause],
    [$.localtime_clause],
    [$.partialdef_clause],
    [$.spaceless_clause],
    [$.timezone_clause],
    [$.with_clause],
    [$.predicate],
    [$.binaryOperator],
    [$.library, $.load_block],
    [$._translate_option],
    [$._filtered_value_spaced],
    [$._filter_expression_spaced],
  ],
  supertypes: ($) => [$.template_node, $.tag_block_group],
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
    $._group_open,
    $._group_close,
  ],
  reserved: {
    global: ($) => ["not", "if", "in", "is", "as", "for", "from"],
    tag_name: ($) => NAMES_INSIDE_A_TAG_GROUP,
  },
  rules: {
    template: ($) => repeat1(choice($.template_node, $.content)),
    content: ($) => /(?:[^\{]|\{[^\{#%}])+/,
    template_node: ($) =>
      choice($.tag_block_group, $.template_variable, $.template_comment),
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
    tag_block_group: ($) =>
      choice(
        $.autoescape_group,
        $.block_group,
        $.blocktranslate_group,
        $.cache_group,
        $.comment_group,
        $.csp_nonce_attr_block,
        $.csrf_token_block,
        $.custom_tag_block,
        $.cycle_block,
        $.debug_block,
        $.extends_block,
        $.filter_group,
        $.firstof_block,
        $.for_group,
        $.get_available_languages_block,
        $.get_current_language_block,
        $.get_current_language_bidi_block,
        $.get_current_timezone_block,
        $.get_language_info_block,
        $.get_language_info_list_block,
        $.get_media_prefix_block,
        $.get_static_prefix_block,
        $.if_group,
        $.ifchanged_group,
        $.include_block,
        $.language_group,
        $.load_block,
        $.localize_group,
        $.localtime_group,
        $.lorem_block,
        $.now_block,
        $.partial_block,
        $.partialdef_group,
        $.querystring_block,
        $.regroup_block,
        $.resetcycle_block,
        $.spaceless_group,
        $.static_block,
        $.templatetag_block,
        $.timezone_group,
        $.translate_block,
        $.url_block,
        $.verbatim_group,
        $.widthratio_block,
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
        $._custom_filter,
      ),
    /**
     * A filter a "load" brought in: its name is not known here, and so neither
     * is whether it takes an argument. Hidden, so the tree is the same as if
     * it were spelled inline, but named so that a grammar extending this one
     * can drop it from filter's alternatives the way it can drop custom_tag_block
     * from tag_block_group.
     */
    _custom_filter: ($) =>
      seq(
        field("name", $.identifier),
        optional(seq(":", field("argument", $.value))),
      ),
    autoescape_block: ($) =>
      groupBlock($._group_open, "autoescape", part(choice("on", "off"))),
    autoescape_clause: ($) => seq($.autoescape_block, optional($.template)),
    endautoescape_block: ($) => groupBlock($._group_close, "endautoescape"),
    autoescape_group: ($) =>
      seq(
        $.autoescape_clause,
        choice(
          $.endautoescape_block,
          alias($._missing_tag, $.missing_endautoescape_block),
        ),
      ),
    // the scanner takes the whitespace before a name it has to match itself
    block_block: ($) => block("block", field("name", $.push_block)),
    block_clause: ($) => seq($.block_block, optional($.template)),
    endblock_block: ($) => block("endblock", $.pop_block),
    block_group: ($) =>
      seq(
        $.block_clause,
        choice(
          $.endblock_block,
          alias($._missing_tag, $.missing_endblock_block),
        ),
      ),
    plural_block: ($) => groupBlock($._group_close, "plural"),
    plural_clause: ($) => seq($.plural_block, optional($._translate_body)),
    ...blocktransRules("blocktrans"),
    ...blocktransRules("blocktranslate"),
    blocktranslate_group: ($) =>
      choice(
        seq(
          $.blocktrans_clause,
          choice(
            $.endblocktrans_block,
            alias($._missing_tag, $.missing_endblocktrans_block),
          ),
        ),
        seq(
          $.blocktranslate_clause,
          choice(
            $.endblocktranslate_block,
            alias($._missing_tag, $.missing_endblocktranslate_block),
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
    cache_block: ($) =>
      groupBlock(
        $._group_open,
        "cache",
        part($.filtered_value),
        part(choice($.identifier, $.string)),
        repeat(part($.filtered_value)),
        optional(part(seq("using=", $.filtered_value))),
      ),
    cache_clause: ($) => seq($.cache_block, optional($.template)),
    endcache_block: ($) => groupBlock($._group_close, "endcache"),
    cache_group: ($) =>
      seq(
        $.cache_clause,
        choice(
          $.endcache_block,
          alias($._missing_tag, $.missing_endcache_block),
        ),
      ),
    comment_block: ($) =>
      groupBlock($._group_open, "comment", optional(part($.string))),
    comment_clause: ($) => seq($.comment_block, optional($.comment_content)),
    endcomment_block: ($) => groupBlock($._group_close, "endcomment"),
    comment_group: ($) =>
      seq(
        $.comment_clause,
        choice(
          $.endcomment_block,
          alias($._missing_tag, $.missing_endcomment_block),
        ),
      ),
    // csp_nonce_attr(context, media=None)
    csp_nonce_attr_block: ($) =>
      simpleTag($, "csp_nonce_attr", 1, { media: $.filtered_value }),
    csrf_token_block: ($) => block("csrf_token"),
    /**
     * A tag a "load" brought in. Its arguments cannot be known here, so what
     * is accepted is what Library.simple_tag and Library.inclusion_tag take,
     * which is how a tag is registered unless it needs the parser itself.
     */
    custom_tag_block: ($) => simpleTag($, reserved("tag_name", $.identifier)),
    cycle_block: ($) =>
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
    debug_block: ($) => block("debug"),
    extends_block: ($) => block("extends", part($.filtered_value)),
    // the filter tag hands Django the rest of its text as one expression rather
    // than as split arguments, so pipes here take whitespace just as they do
    // between "{{" and "}}"
    filter_block: ($) =>
      groupBlock(
        $._group_open,
        "filter",
        part(alias($._filter_expression_spaced, $.filter_expression)),
      ),
    filter_clause: ($) => seq($.filter_block, optional($.template)),
    endfilter_block: ($) => groupBlock($._group_close, "endfilter"),
    filter_group: ($) =>
      seq(
        $.filter_clause,
        choice(
          $.endfilter_block,
          alias($._missing_tag, $.missing_endfilter_block),
        ),
      ),
    firstof_block: ($) =>
      block(
        "firstof",
        repeat1(part($.filtered_value)),
        optional(asVariable($)),
      ),
    for_block: ($) =>
      groupBlock(
        $._group_open,
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
          seq(
            part(wordAsValue($, "reversed", true)),
            optional(part("reversed")),
          ),
          seq(part(wordAsValue($, "reversed", false)), part("reversed")),
        ),
      ),
    for_clause: ($) => seq($.for_block, optional($.template)),
    empty_block: ($) => block("empty"),
    empty_clause: ($) => seq($.empty_block, optional($.template)),
    endfor_block: ($) => groupBlock($._group_close, "endfor"),
    for_group: ($) =>
      seq(
        $.for_clause,
        optional($.empty_clause),
        choice($.endfor_block, alias($._missing_tag, $.missing_endfor_block)),
      ),
    /**
     * django.templatetags.i18n. Each of these requires exactly "as <name>",
     * or "for <expression> as <name>", and rejects anything further.
     */
    get_available_languages_block: ($) =>
      block("get_available_languages", asVariable($)),
    get_current_language_block: ($) =>
      block("get_current_language", asVariable($)),
    get_current_language_bidi_block: ($) =>
      block("get_current_language_bidi", asVariable($)),
    get_language_info_block: ($) =>
      block("get_language_info", part("for", $.filtered_value), asVariable($)),
    get_language_info_list_block: ($) =>
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
    get_current_timezone_block: ($) =>
      block("get_current_timezone", asVariable($)),
    get_media_prefix_block: ($) =>
      block("get_media_prefix", optional(asVariable($))),
    get_static_prefix_block: ($) =>
      block("get_static_prefix", optional(asVariable($))),
    if_block: ($) => groupBlock($._group_open, "if", part($.predicate)),
    if_clause: ($) => seq($.if_block, optional($.template)),
    elif_block: ($) => block("elif", part($.predicate)),
    elif_clause: ($) => seq($.elif_block, optional($.template)),
    /** Shared by if_group and ifchanged_group, which spell it the same way. */
    else_block: ($) => block("else"),
    else_clause: ($) => seq($.else_block, optional($.template)),
    endif_block: ($) => groupBlock($._group_close, "endif"),
    if_group: ($) =>
      seq(
        $.if_clause,
        repeat($.elif_clause),
        optional($.else_clause),
        choice($.endif_block, alias($._missing_tag, $.missing_endif_block)),
      ),
    ifchanged_block: ($) =>
      groupBlock($._group_open, "ifchanged", repeat(part($.filtered_value))),
    ifchanged_clause: ($) => seq($.ifchanged_block, optional($.template)),
    endifchanged_block: ($) => groupBlock($._group_close, "endifchanged"),
    ifchanged_group: ($) =>
      seq(
        $.ifchanged_clause,
        optional($.else_clause),
        choice(
          $.endifchanged_block,
          alias($._missing_tag, $.missing_endifchanged_block),
        ),
      ),
    /**
     * do_include takes "with" and "only" in either order and refuses one it has
     * already been given, and "with" needs at least one argument. It calls
     * token_kwargs with support_legacy=False, so "{% include "t" with a as b %}"
     * is an error here as it is there, unlike the same clause in "{% with %}".
     */
    include_block: ($) =>
      block(
        "include",
        $._tag_open,
        part($.filtered_value),
        optional(
          arrangements([seq(part("with"), $._tag_kwargs), part("only")]),
        ),
      ),
    /** django.templatetags.i18n. The language tag takes the one argument. */
    language_block: ($) =>
      groupBlock($._group_open, "language", part($.filtered_value)),
    language_clause: ($) => seq($.language_block, optional($.template)),
    endlanguage_block: ($) => groupBlock($._group_close, "endlanguage"),
    language_group: ($) =>
      seq(
        $.language_clause,
        choice(
          $.endlanguage_block,
          alias($._missing_tag, $.missing_endlanguage_block),
        ),
      ),
    library: ($) => seq($.identifier, optional(seq(".", $.identifier))),
    load_block: ($) =>
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
    localize_block: ($) =>
      groupBlock(
        $._group_open,
        "localize",
        optional(part(choice("on", "off"))),
      ),
    localize_clause: ($) => seq($.localize_block, optional($.template)),
    endlocalize_block: ($) => groupBlock($._group_close, "endlocalize"),
    localize_group: ($) =>
      seq(
        $.localize_clause,
        choice(
          $.endlocalize_block,
          alias($._missing_tag, $.missing_endlocalize_block),
        ),
      ),
    /** django.templatetags.tz, taking "on" or "off" as localize does. */
    localtime_block: ($) =>
      groupBlock(
        $._group_open,
        "localtime",
        optional(part(choice("on", "off"))),
      ),
    localtime_clause: ($) => seq($.localtime_block, optional($.template)),
    endlocaltime_block: ($) => groupBlock($._group_close, "endlocaltime"),
    localtime_group: ($) =>
      seq(
        $.localtime_clause,
        choice(
          $.endlocaltime_block,
          alias($._missing_tag, $.missing_endlocaltime_block),
        ),
      ),
    lorem_block: ($) =>
      block(
        "lorem",
        part($.filtered_value),
        part(choice("w", "p", "b")),
        optional(part("random")),
      ),
    now_block: ($) => block("now", part($.string), optional(asVariable($))),
    partial_block: ($) => block("partial", part($.identifier)),
    partialdef_block: ($) =>
      block("partialdef", $.push_partial, optional(part("inline"))),
    partialdef_clause: ($) => seq($.partialdef_block, optional($.template)),
    endpartialdef_block: ($) => block("endpartialdef", $.pop_partial),
    partialdef_group: ($) =>
      seq(
        $.partialdef_clause,
        choice(
          $.endpartialdef_block,
          alias($._missing_tag, $.missing_endpartialdef_block),
        ),
      ),
    // querystring(context, *args, **kwargs)
    querystring_block: ($) => simpleTag($, "querystring"),
    regroup_block: ($) =>
      block(
        "regroup",
        part($.filtered_value),
        part("by"),
        part($.attribute),
        optional(asVariable($)),
      ),
    resetcycle_block: ($) => block("resetcycle", optional(part($.identifier))),
    spaceless_block: ($) => groupBlock($._group_open, "spaceless"),
    spaceless_clause: ($) => seq($.spaceless_block, optional($.template)),
    endspaceless_block: ($) => groupBlock($._group_close, "endspaceless"),
    spaceless_group: ($) =>
      seq(
        $.spaceless_clause,
        choice(
          $.endspaceless_block,
          alias($._missing_tag, $.missing_endspaceless_block),
        ),
      ),
    static_block: ($) =>
      block("static", part($.filtered_value), optional(asVariable($))),
    templatetag_block: ($) =>
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
    timezone_block: ($) =>
      groupBlock($._group_open, "timezone", part($.filtered_value)),
    timezone_clause: ($) => seq($.timezone_block, optional($.template)),
    endtimezone_block: ($) => groupBlock($._group_close, "endtimezone"),
    timezone_group: ($) =>
      seq(
        $.timezone_clause,
        choice(
          $.endtimezone_block,
          alias($._missing_tag, $.missing_endtimezone_block),
        ),
      ),
    /**
     * django.templatetags.i18n, registered under both spellings. do_translate
     * pops its options off one at a time and refuses one it has already seen,
     * so they may be written in any order but none of them twice.
     */
    translate_block: ($) =>
      block(
        choice("trans", "translate"),
        part($.filtered_value),
        optional(
          arrangements([
            part("noop"),
            // do_translate refuses "as" and "noop" as the context, comparing
            // the whole bit, so a lookup that only begins with one is fine
            part(
              "context",
              choice($.filtered_value, wordAsValue($, "noop", true)),
            ),
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
    verbatim_block: ($) => block("verbatim", $.push_verbatim),
    verbatim_clause: ($) => seq($.verbatim_block, optional($.verbatim_content)),
    endverbatim_block: ($) => block("endverbatim", $.pop_verbatim),
    verbatim_group: ($) =>
      seq(
        $.verbatim_clause,
        choice(
          $.endverbatim_block,
          alias($._missing_tag, $.missing_endverbatim_block),
        ),
      ),
    widthratio_block: ($) =>
      block(
        "widthratio",
        part($.filtered_value),
        part($.filtered_value),
        part($.filtered_value),
        optional(asVariable($)),
      ),
    with_block: ($) =>
      groupBlock($._group_open, "with", $._tag_open, $._tag_kwargs),
    with_clause: ($) => seq($.with_block, optional($.template)),
    endwith_block: ($) => groupBlock($._group_close, "endwith"),
    with_group: ($) =>
      seq(
        $.with_clause,
        choice($.endwith_block, alias($._missing_tag, $.missing_endwith_block)),
      ),
  },
});

export default django;
