
(identifier) @variable

variable: (identifier) @variable.parameter


(block_group
    (push_block) @type)

(partialdef_group
    (push_partial) @type)

(verbatim_group
    (push_verbatim) @type)

(comment_content) @comment
(template_comment) @comment
(attribute) @attribute

[
    (binaryOperator)
    ("is")
    ("not")
    ("as")
    ("in")
    ("=")
    ("|")
    (":")
    (".")] @operator

[
    ("{{")
    ("{#")
    ("{%")
    ("}}")
    ("#}")
    ("%}")
    ("_(")
    (")")
    (",")] @punctuation

(number) @number
(string) @string

(library
    (identifier) @module)

tag: [
    ("autoescape")
    ("endautoescape")
    ("block")
    ("endblock")
    ("cache")
    ("endcache")
    ("comment")
    ("endcomment")
    ("csp_nonce_attr")
    ("csrf_token")
    ("cycle")
    ("debug")
    ("extends")
    ("filter")
    ("endfilter")
    ("firstof")
    ("for")
    ("empty")
    ("endfor")
    ("for")
    ("empty")
    ("endfor")
    ("get_available_languages")
    ("get_current_language")
    ("get_current_language_bidi")
    ("get_current_timezone")
    ("get_language_info")
    ("get_language_info_list")
    ("get_media_prefix")
    ("get_static_prefix")
    ("if")
    ("elif")
    ("else")
    ("endif")
    ("ifchanged")
    ("endifchanged")
    ("include")
    ("language")
    ("endlanguage")
    ("lorem")
    ("load")
    ("localize")
    ("endlocalize")
    ("localtime")
    ("endlocaltime")
    ("now")
    ("partial")
    ("partialdef")
    ("endpartialdef")
    ("querystring")
    ("regroup")
    ("resetcycle")
    ("spaceless")
    ("endspaceless")
    ("static")
    ("templatetag")
    ("timezone")
    ("endtimezone")
    ("trans")
    ("translate")
    ("url")
    ("verbatim")
    ("endverbatim")
    ("with")
    ("endwith")] @function

(filter
    name: [
        ("add")
        ("addslashes")
        ("capfirst")
        ("center")
        ("cut")
        ("date")
        ("default")
        ("default_if_none")
        ("dictsort")
        ("dictsortreversed")
        ("divisibleby")
        ("escape")
        ("escapejs")
        ("escapeseq")
        ("filesizeformat")
        ("first")
        ("floatformat")
        ("force_escape")
        ("get_digit")
        ("iriencode")
        ("join")
        ("json_script")
        ("language_bidi")
        ("language_name")
        ("language_name_local")
        ("language_name_translated")
        ("last")
        ("length")
        ("linebreaks")
        ("linebreaksbr")
        ("linenumbers")
        ("ljust")
        ("localize")
        ("localtime")
        ("lower")
        ("make_list")
        ("phone2numeric")
        ("pluralize")
        ("pprint")
        ("random")
        ("rjust")
        ("safe")
        ("safeseq")
        ("slice")
        ("slugify")
        ("stringformat")
        ("striptags")
        ("time")
        ("timesince")
        ("timeuntil")
        ("timezone")
        ("title")
        ("truncatechars")
        ("truncatechars_html")
        ("truncatewords")
        ("truncatewords_html")
        ("unlocalize")
        ("unordered_list")
        ("upper")
        ("urlencode")
        ("urlize")
        ("urlizetrunc")
        ("utc")
        ("wordcount")
        ("wordwrap")
        ("yesno")] @function)

; a filter or tag a "load" brought in, whose name the grammar does not know
(filter
    name: (identifier) @function.call)

(custom_tag
    tag: (identifier) @function.call)

(load
    (identifier) @function)
