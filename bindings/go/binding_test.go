package tree_sitter_django_test

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"
	tree_sitter_django "github.com/danhanson/tree-sitter-django/bindings/go"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_django.Language())
	if language == nil {
		t.Errorf("Error loading Django Parser grammar")
	}
}
