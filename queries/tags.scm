(load_tag
    (identifier) @name) @definition.function

(partialdef_tag (push_partial) @name) @definition.method
(partial_tag (identifier) @name) @reference.call

; a tag that opens no body names itself; a group is named by the first tag of
; its first block, so neither its end tag nor the tags opening its later blocks
; are references of their own
(template_tag
    tag_name: _ @name) @reference.call

(template_tag
    .
    (_
        .
        (_
            tag_name: _ @name))) @reference.call

(filter) @reference.call
