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

[
  (static)
  (get_static_prefix)
  (get_media_prefix)] @library.static

; "{% load static %}" makes every name in the library available; "{% load
; static from staticfiles %}" makes only the names listed available.
(load
  (library) @load.library)

(load
  (identifier) @load.name)
