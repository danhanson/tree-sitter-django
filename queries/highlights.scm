
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
    (".")] @operator

[
    ("{{")
    ("{#")
    ("{%")
    ("}}")
    ("#}")
    ("%}")
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
    ("templatetag")
    ("url")
    ("verbatim")
    ("endverbatim")
    ("with")
    ("endwith")] @function

(filter .
    [
        ("add:")
        ("addslashes")
        ("capfirst")
        ("center:")
        ("cut:")
        ("date")
        ("date:")
        ("default:")
        ("default_if_none:")
        ("dictsort:")
        ("dictsortreversed:")
        ("divisibleby:")
        ("escape")
        ("escapejs")
        ("filesizeformat")
        ("first")
        ("floatformat")
        ("floatformat:")
        ("force_escape")
        ("get_digit:")
        ("iriencode")
        ("join:")
        ("json_script")
        ("json_script:")
        ("last")
        ("length")
        ("length_is:")
        ("linebreaks")
        ("linebreaksbr")
        ("linenumbers")
        ("ljust:")
        ("lower")
        ("make_list")
        ("phone2numeric")
        ("pluralize")
        ("pluralize:")
        ("pprint")
        ("random")
        ("rjust:")
        ("safe")
        ("safeseq")
        ("slice:")
        ("slugify")
        ("stringformat:")
        ("striptags")
        ("time")
        ("time:")
        ("timesince")
        ("timesince:")
        ("timeuntil")
        ("timeuntil:")
        ("title")
        ("truncatechars:")
        ("truncatechars_html:")
        ("truncatewords:")
        ("truncatewords_html:")
        ("unordered_list")
        ("upper")
        ("urlencode")
        ("urlencode:")
        ("urlize")
        ("urlizetrunc:")
        ("wordcount")
        ("wordwrap:")
        ("yesno")
        ("yesno:")] @function)

(load
    (identifier) @function)
