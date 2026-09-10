
(identifier) @local.reference

variable: (identifier) @local.definition

; The tags whose Node pushes a context, so that what they bind is not visible
; after them. Verified by rendering: "{% block b %}{% now "Y" as n %}{% endblock %}{{ n }}"
; is empty, while the same around an "{% if %}" is not, because if does not push.
(with_clause) @local.scope
(for_clause) @local.scope
(block_clause) @local.scope
(partialdef_clause) @local.scope

; ForNode renders nodelist_empty inside the same context.push() as the loop
; body, so "{% empty %}" is part of the loop's scope even though it is a
; separate clause: "{% for x in ys %}a{% empty %}{% now "Y" as n %}{% endfor %}{{ n }}"
; is empty. queries/conditionals.scm names both clauses as branches of the
; same group and relies on this.
(empty_clause) @local.scope

; blocktranslate pushes a context for its "with" and "count" bindings. Its
; asvar target is not one of them: it is written in the same tag but assigned
; outside it, and carries an "asvar" field rather than "variable" so that this
; scope does not swallow it. A tool that wants it must define it in the scope
; around the block, which a locals query has no way to say.
(blocktranslate_group) @local.scope
