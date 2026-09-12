(load_block
    (identifier) @name) @definition.function

(partialdef_block (push_partial) @name) @definition.method
(partial_block (identifier) @name) @reference.call

; a tag that opens no body names itself; a group is named by the first block of
; its first clause, so neither its end block nor the blocks opening its later
; clauses are references of their own
(tag_block_group
    tag: _ @name) @reference.call

(tag_block_group
    .
    (_
        .
        (_
            tag: _ @name))) @reference.call

(filter) @reference.call
