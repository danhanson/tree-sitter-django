(load
    (identifier) @name) @definition.function

(partialdef_clause (push_partial) @name) @definition.method
(partial (identifier) @name) @reference.call

; every tag that opens a group names itself in a clause of its own, and every
; tag that does not is a group member directly
(template_block_groups
    [
        (_
            tag: _ @name)
        (_
            (_
                tag: _ @name))] @reference.call)

(filter) @reference.call
