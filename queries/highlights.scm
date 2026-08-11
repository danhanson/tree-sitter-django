; Identifiers

(cycle name:
    name: (identifier) @variable)

(block_group
    name: (push_block) @block_name)

(partialdef_group
    name: (push_partial) @partial_name)

(verbatim_group
    name: (push_verbatim) @verbatim_name)

(with_group
    variables: (_
        name: (identifier) @variable))

; Literals

(number) @number
(string) @string

; Constants

(template_block_groups
    tag: (_) @tag)

(filter . (_) @filter)
