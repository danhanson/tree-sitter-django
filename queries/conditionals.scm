; Which parts of a template render conditionally, for a tool checking that a
; variable is defined on every path that reaches a use of it.
;
; Django binds an "as" target straight into the context, and a tag that pushes
; no context leaves that binding visible after its group closes. So
;
;     {% if a %}{% now "Y" as n %}{% endif %}{{ n }}
;
; renders the year when a is truthy and string_if_invalid ("" by default) when
; it is not — a silent empty string, not an error. queries/locals.scm cannot
; see that: a locals query matches a reference to the definition whose scope
; contains it and has no notion of a path that may not be taken.
;
; The halves a tool joins, by grouping matches on the @conditional.group node:
;
;   @conditional.group    the whole construct
;   @conditional.branch   one alternative; at most one of a group's branches
;                         renders on any given pass
;   @conditional.default  the branch that renders when no other one does
;
; A group is exhaustive iff one of its matches carries a @conditional.default.
; If it is not, some pass through it binds nothing, so every definition inside
; is conditional. If it is, a definition escapes only when every branch makes
; it. Each capture names both halves of the pair, so no ancestor walk is needed
; and no clause has to be attributed to a group by name.
;
; Branches nest, so the same test applies again to a group inside a branch.
;
; A branch that is also a @local.scope in queries/locals.scm confines its
; bindings whether or not it renders; the two queries compose and the scope
; decides first.

; if/elif are alternatives tested in order; else runs when none matched. None
; of the three pushes a context, so this is the case the check exists for.
(if_group
  [
    (if_clause)
    (elif_clause)
  ] @conditional.branch) @conditional.group

(if_group
  (else_clause) @conditional.default) @conditional.group

; ifchanged renders its body only when the watched value differs from the
; previous pass, and its else otherwise. It pushes no context either.
(ifchanged_group
  (ifchanged_clause) @conditional.branch) @conditional.group

(ifchanged_group
  (else_clause) @conditional.default) @conditional.group

; The loop body runs once per item and empty runs when there are none, so the
; two partition every render. Both are inside ForNode's context.push() — the
; empty branch included, which is easy to miss — so locals.scm scopes both and
; nothing escapes either way. Named here because the construct does branch, and
; because a tool reading only this file should not have to infer that it does.
(for_group
  (for_clause) @conditional.branch) @conditional.group

(for_group
  (empty_clause) @conditional.default) @conditional.group

; A cache body is skipped entirely on a cache hit, and CacheNode pushes no
; context, so a binding made inside it reaches the rest of the template on the
; first render and is gone on the next. One branch and no default: never
; exhaustive, which is the right answer.
(cache_group
  (cache_clause) @conditional.branch) @conditional.group

; Not here, deliberately: block and partialdef bodies may also fail to render —
; a child template overrides the block, and a partial renders only where
; {% partial %} names it — but both clauses are @local.scope in locals.scm, so
; nothing they bind escapes to be checked. Bodies that always render once
; (with, filter, autoescape, spaceless, language, localize, localtime,
; timezone) are not conditional at all, and comment, verbatim and
; blocktranslate bodies hold no tags to bind anything.
