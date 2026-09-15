; Everything in a template that an editor should report as a problem.
;
; A group whose required tag is missing parses without an ERROR: the scanner
; supplies a zero-width marker where the tag belongs, so the group, its blocks
; and the scopes they open stay intact for completion and the other queries.
; Such a tree has no error of its own (ts_node_has_error is false), so a tool
; has to run this query to find them.
;
;   @error.syntax        input the grammar could not parse
;   @error.missing       a token that tree-sitter's error recovery inserted
;   @error.missing_tag expected tag block is missing
;
; The markers are listed one by one, as MISSING_TAGS in grammar.js: the
; generator drops a supertype whose members are aliases, so there is no single
; node type to match them all. A new tag group, or a new kind of marker, is
; added here.

(ERROR) @error.syntax

(MISSING) @error.missing

[
    (missing_endautoescape_tag)
    (missing_endblock_tag)
    (missing_endblocktrans_tag)
    (missing_endblocktranslate_tag)
    (missing_endcache_tag)
    (missing_endcomment_tag)
    (missing_endfilter_tag)
    (missing_endfor_tag)
    (missing_endif_tag)
    (missing_endifchanged_tag)
    (missing_endlanguage_tag)
    (missing_endlocalize_tag)
    (missing_endlocaltime_tag)
    (missing_endpartialdef_tag)
    (missing_endspaceless_tag)
    (missing_endtimezone_tag)
    (missing_endverbatim_tag)
    (missing_endwith_tag)
    (missing_plural_tag)] @error.missing_tag

(unexpected_tag) @error.unexpected_tag

(unexpected_argument) @error.unexpected_argument

(missing_variable_close) @error.missing_variable_close
