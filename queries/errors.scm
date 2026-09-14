; Everything in a template that an editor should report as a problem.
;
; A group whose required tag is missing parses without an ERROR: the scanner
; supplies a zero-width marker where the tag belongs, so the group, its clauses
; and the scopes they open stay intact for completion and the other queries.
; Such a tree has no error of its own (ts_node_has_error is false), so a tool
; has to run this query to find them.
;
;   @error.syntax        input the grammar could not parse
;   @error.missing       a token that tree-sitter's error recovery inserted
;   @error.missing_block expected tag block is missing
;
; The markers are listed one by one, as MISSING_BLOCKS in grammar.js: the
; generator drops a supertype whose members are aliases, so there is no single
; node type to match them all. A new tag group, or a new kind of marker, is
; added here.

(ERROR) @error.syntax

(MISSING) @error.missing

[
    (missing_endautoescape_block)
    (missing_endblock_block)
    (missing_endblocktrans_block)
    (missing_endblocktranslate_block)
    (missing_endcache_block)
    (missing_endcomment_block)
    (missing_endfilter_block)
    (missing_endfor_block)
    (missing_endif_block)
    (missing_endifchanged_block)
    (missing_endlanguage_block)
    (missing_endlocalize_block)
    (missing_endlocaltime_block)
    (missing_endpartialdef_block)
    (missing_endspaceless_block)
    (missing_endtimezone_block)
    (missing_endverbatim_block)
    (missing_endwith_block)
    (missing_plural_block)] @error.missing_block

(unexpected_block) @error.unexpected_block
