(load
    (identifier) @name) @definition.function

(partialdef_group (push_partial) @name) @definition.method
(partial (identifier) @name) @reference.call

(template_block_groups
    [
        (_
            tag: _ @name) @reference.call
        (for_group
            (for_scope
                tag: "for" @reference.call))])

(filter) @reference.call
