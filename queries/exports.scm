; Names a tag binds in the scope *around* it rather than in the scope it opens.
;
; queries/locals.scm cannot express this: a locals query places a definition in
; the innermost @local.scope whose span contains it, and there is no way to let
; one out again. A tool reads this file alongside locals.scm and binds
; @export.name in the nearest scope enclosing @export.from, not inside it.
;
; Only blocktranslate does this. Its asvar target is written inside the opening
; tag — which is inside the scope, because the "with" and "count" bindings in
; that same tag do belong to the block — but it holds the rendered text and is
; read after the block:
;
;     {% blocktranslate with bar=foo asvar var %}…{% endblocktranslate %}
;     {{ var }}
;
; It carries an "asvar" field rather than "variable" so locals.scm leaves it
; alone. Every other "as name" clause is written in a tag that opens no scope,
; so locals.scm already places those correctly and none of them belong here.
;
; asvar and the "with" bindings may be written in either order, so no single
; scope span could have separated them; that is why this is a separate file
; rather than a narrower scope in locals.scm.

(blocktrans_block
  (blocktrans_tag
    asvar: (identifier) @export.name)) @export.from

(blocktranslate_block
  (blocktranslate_tag
    asvar: (identifier) @export.name)) @export.from
