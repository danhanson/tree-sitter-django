; Which library a tag or filter is registered in.
;
; The grammar accepts these whether or not a "{% load %}" precedes them: an
; engine may preload a library through its "builtins" option, and Django
; resolves a name against the libraries loaded *so far*, which is a question
; about the order of nodes rather than about how the template parses. A tool
; that wants to report a missing load can run this query and compare positions
; itself, and should skip the check for a library the engine preloads.
;
; Loading is per file and positional: "{% load %}" does not reach a template
; that extends or includes this one, and a tag written before the load is an
; error even though the load is in the same file.

; Each pattern captures the name a library registered, rather than the node it
; heads, so that the capture is both the name to look up and the range to
; report. A paired tag names the opening tag only.

(static_tag
  tag_name: ("static") @library.static)

(get_static_prefix_tag
  tag_name: ("get_static_prefix") @library.static)

(get_media_prefix_tag
  tag_name: ("get_media_prefix") @library.static)

(blocktrans_tag
  tag_name: ("blocktrans") @library.i18n)

(blocktranslate_tag
  tag_name: ("blocktranslate") @library.i18n)

(translate_tag
  tag_name: [
    ("trans")
    ("translate")] @library.i18n)

(language_tag
  tag_name: ("language") @library.i18n)

(get_available_languages_tag
  tag_name: ("get_available_languages") @library.i18n)

(get_current_language_tag
  tag_name: ("get_current_language") @library.i18n)

(get_current_language_bidi_tag
  tag_name: ("get_current_language_bidi") @library.i18n)

(get_language_info_tag
  tag_name: ("get_language_info") @library.i18n)

(get_language_info_list_tag
  tag_name: ("get_language_info_list") @library.i18n)

(filter
  filter_name: [
    ("language_bidi")
    ("language_name")
    ("language_name_local")
    ("language_name_translated")] @library.i18n)

(cache_tag
  tag_name: ("cache") @library.cache)

(localize_tag
  tag_name: ("localize") @library.l10n)

(filter
  filter_name: [
    ("localize")
    ("unlocalize")] @library.l10n)

(localtime_tag
  tag_name: ("localtime") @library.tz)

(timezone_tag
  tag_name: ("timezone") @library.tz)

(get_current_timezone_tag
  tag_name: ("get_current_timezone") @library.tz)

(filter
  filter_name: [
    ("localtime")
    ("timezone")
    ("utc")] @library.tz)

; "{% load static %}" makes every name in the library available; "{% load
; static from staticfiles %}" makes only the names listed available.
(load_tag
  (library) @load.library)

(load_tag
  (identifier) @load.name)
