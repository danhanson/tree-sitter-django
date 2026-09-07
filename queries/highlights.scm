
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
    ("get_media_prefix")
    ("get_static_prefix")
    ("if")
    ("elif")
    ("else")
    ("endif")
    ("ifchanged")
    ("endifchanged")
    ("include")
    ("lorem")
    ("load")
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
        ("last")
        ("length")
        ("linebreaks")
        ("linebreaksbr")
        ("linenumbers")
        ("ljust")
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
        ("title")
        ("truncatechars")
        ("truncatechars_html")
        ("truncatewords")
        ("truncatewords_html")
        ("unordered_list")
        ("upper")
        ("urlencode")
        ("urlize")
        ("urlizetrunc")
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
