# tree-sitter-django

A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for the Django Template Language (DTL) — the `{% %}` tags and `{{ }}` variables used in Django templates.

## Development

```sh
npm install
npm run parser-generate  # regenerate the parser from grammar.js
npm run parser-test      # run the corpus tests in test/corpus
npm run parser-build     # build the WASM binary
npm run playground       # interactively explore the grammar
```
