#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include <string.h>

#define ERROR_SIZE 64
#define STACK_COUNT 3
#define NAME_SEP ' '
#define STACK_SEP '\n'

enum TokenType {
  /* indicates that an error occurred */
  MatcherError,
  /* push name on stack to match with later */
  PopBlock,     // [ name ] %}
  PopPartial,   // [ name ] %}
  PopVerbatim,  // [ name ] %}
  /* pop name when done with it */
  PushBlock,    // name %}
  PushPartial,  // name [ inline ] %}
  PushVerbatim, // [ name ] %}
  /* raw text inside a verbatim block, up through (but excluding) the matching endverbatim tag */
  VerbatimContent,
  /* raw text inside a comment block, up through (but excluding) the endcomment tag */
  CommentContent,
  /* zero-width markers for the whitespace preceding a keyword, in the same
   * order as separated_keywords below */
  BeforeAnd,
  BeforeAs,
  BeforeB,
  BeforeBy,
  BeforeIn,
  BeforeIs,
  BeforeNot,
  BeforeOr,
  BeforeP,
  BeforeRandom,
  BeforeW,
  /* zero-width marker for the end of a literal */
  AfterLiteral,
};

/* Keywords Django only reads as keywords when whitespace separates them from
 * the token before, listed in BeforeAnd..BeforeW order. */
static const char *const separated_keywords[] = {
  "and", "as", "b", "by", "in", "is", "not", "or", "p", "random", "w",
};

#define KEYWORD_COUNT (sizeof(separated_keywords) / sizeof(*separated_keywords))
#define KEYWORD_SIZE 6 // "random", the longest of them

typedef Array(int32_t) Name;
typedef Array(Name) Stack;

struct Scanner {
  bool has_error;
  union {
    Stack stacks [STACK_COUNT];
    char error [ERROR_SIZE];
  };
};

static Stack* get_stack_for_token(struct Scanner *scanner, enum TokenType token) {
  if (token < PopBlock || token > PushVerbatim) {
    return NULL;
  }
  // the pop and push tokens are in the same order, so each pair shares a stack
  return &scanner->stacks[(token - PopBlock) % STACK_COUNT];
}

static void reset_scanner(struct Scanner *const scanner) {
  if (scanner->has_error) {
    scanner->error[0] = '\0';
    scanner->has_error = false;
  } else {
    for (unsigned i = 0; i < STACK_COUNT; ++i) {
      Stack *stack = &scanner->stacks[i];
      for (unsigned i = 0; i < stack->size; ++i) {
        array_delete(array_get(stack, i));
      }
      array_delete(stack);
    }
  }
}

#define scanner_error(scanner, string) do {\
  struct Scanner *_scanner = scanner;\
  reset_scanner(_scanner);\
  _scanner->has_error = true;\
  _scanner->error[0] = '\0';\
  /*strncat(_scanner->error, string, ERROR_SIZE - 1);*/\
} while(0)

#define min(a, b)\
  ({\
    typeof(a) _a = (a);\
    typeof(b) _b = (b);\
    _a > _b ? _a : _b;\
  })

void * tree_sitter_django_external_scanner_create() {
  return ts_calloc(1, sizeof(struct Scanner));
}

void tree_sitter_django_external_scanner_destroy(void *payload) {
  struct Scanner *scanner = (struct Scanner*) payload;
  reset_scanner(scanner);
  ts_free(payload);
}

static unsigned write_code(int32_t code, char *out) {
  if (code <= 0x7F) {
      // 1 byte: 0xxxxxxx
      out[0] = code;
      return 1;
  } 
  else if (code <= 0x7FF) {
      // 2 bytes: 110xxxxx 10xxxxxx
      out[0] = (code >> 6)  | 0xC0;
      out[1] = (code & 0x3F) | 0x80;
      return 2;
  } 
  else if (code <= 0xFFFF) {
      // 3 bytes: 1110xxxx 10xxxxxx 10xxxxxx
      // Note: Code points U+D800 to U+DFFF are reserved for UTF-16 surrogates and are invalid
      if (code >= 0xD800 && code <= 0xDFFF) {
        return 0;
      }

      out[0] = (code >> 12) | 0xE0;
      out[1] = ((code >> 6) & 0x3F) | 0x80;
      out[2] = (code & 0x3F) | 0x80;
      return 3;
  } 
  else if (code <= 0x10FFFF) {
      // 4 bytes: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
      out[0] = (code >> 18) | 0xF0;
      out[1] = ((code >> 12) & 0x3F) | 0x80;
      out[2] = ((code >> 6) & 0x3F) | 0x80;
      out[3] = (code & 0x3F) | 0x80;
      return 4;
  }
  return 0; // Out of Unicode range
}

unsigned tree_sitter_django_external_scanner_serialize(
  void *payload,
  char *const buffer
) {
  struct Scanner *scanner = (struct Scanner*) payload;

write_serialization_error:;
  char *iter = buffer;

  iter += write_code(scanner->has_error + '0', iter);
  if (scanner->has_error) {
    for (int i = 0; i < ERROR_SIZE; ++i) {
      char value = scanner->error[i];
      *(iter++) = value;
      if (value == '\0') {
        break;
      }
    }
  } else {
    // Ok scanner requires copying its stack
    for (unsigned i = 0; i < STACK_COUNT; ++i) {
      Stack *stack = &scanner->stacks[i];
      for (unsigned i = 0; i < stack->size; ++i) {
        Name *name = array_get(stack, i);
        for (unsigned j = 0; j < name->size; ++j) {
          int32_t code = *array_get(name, j);
          unsigned write_amt = write_code(code, iter);
          if (write_amt == 0) {
            scanner_error(scanner, "bad code from name");
            goto write_serialization_error;
          }
          iter += write_amt;
        }
        iter += write_code(NAME_SEP, iter);
      }
      iter += write_code(STACK_SEP, iter);
    }
  }
  return iter - buffer;
}

static unsigned read_code(const char *iter, int32_t *result) {
  unsigned char byte0 = iter[0];
  if (byte0 <= 0x7F) {
    // 1 byte: 0xxxxxxx
    *result = byte0;
    return 1;
  } else if ((byte0 & 0xE0) == 0xC0) {
    // 2 bytes: 110xxxxx 10xxxxxx
    *result = ((byte0 & 0x1F) << 6) | (iter[1] & 0x3F);
    return 2;
  } else if ((byte0 & 0xF0) == 0xE0) {
    // 3 bytes: 1110xxxx 10xxxxxx 10xxxxxx
    *result = ((byte0 & 0x0F) << 12) | ((iter[1] & 0x3F) << 6) | (iter[2] & 0x3F);
    return 3;
  } else if ((byte0 & 0xF8) == 0xF0) {
    // 4 bytes: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
    *result = ((byte0 & 0x07) << 18) | ((iter[1] & 0x3F) << 12) | ((iter[2] & 0x3F) << 6) | (iter[3] & 0x3F);
    return 4;
  }
  return 0; // invalid UTF-8 leading byte
}

static bool check_name_start_char(const int32_t letter) {
  return 'a' <= letter && letter <= 'z' || 'A' <= letter && letter <= 'Z';
}

static bool check_name_char(const int32_t letter) {
  return check_name_start_char(letter) || '0' <= letter && letter <= '9' || letter == '_';
}

void tree_sitter_django_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  struct Scanner *scanner = (struct Scanner*) payload;
  reset_scanner(scanner);
  if (length == 0) {
    return;
  }
  int32_t code;
  unsigned bytes_read = read_code(buffer, &code);
  if (!bytes_read) {
    scanner_error(scanner, "received invalid utf8 byte");
    return;
  }
  if (bytes_read > length) {
    scanner_error(scanner, "status code truncated by length");
    return;
  }
  buffer += bytes_read;
  switch (code) {
    default:
      scanner_error(scanner, "received unrecognized scanner status");
      return;
    case '1': {
      scanner->has_error = true;
      for (unsigned i = 0; i < length - bytes_read; ++i) {
        char value = *(buffer++);
        scanner->error[i] = value;
        if (value == '\0') {
          break;
        }
      }
      return;
    }
    case '0': {
      scanner->has_error = false;
      const char *end = buffer + length - bytes_read;
      Stack *stack = scanner->stacks;
      Stack *stack_end = stack + STACK_COUNT;
      Name *name = NULL;

      while (stack < stack_end) {
        bytes_read = read_code(buffer, &code);
        if (bytes_read == 0) {
          scanner_error(scanner, "Bad utf8 byte");
          return;
        }
        buffer += bytes_read;
        if (buffer > end) {
          scanner_error(scanner, "Scanner truncated by length");
          return;
        }
        if (code == STACK_SEP) {
          ++stack;
          name = NULL;
          continue;
        } else if (code == NAME_SEP) {
          if (name == NULL) {
            // an empty name was pushed (e.g. an anonymous verbatim block)
            array_push(stack, (Name) array_new());
          } else {
            name = NULL;
          }
        } else {
          if (name == NULL) {
            if (!check_name_start_char(code)) {
              scanner_error(scanner, "Invalid name, must start with letter");
              return;
            }
            array_push(stack, (Name) array_new());
            name = array_back(stack);
          } else if (!check_name_char(code)) {
            scanner_error(scanner, "Invalid character in name");
            return;
          }
          array_push(name, code);
        }
      }
      if (buffer != end) {
        scanner_error(scanner, "Scanner deserialization finished with left over length");
      }
    }
  }
}

static bool read_name(TSLexer *const lexer, Name *const name) {
  if (name->size == 0) {
    if (!check_name_start_char(lexer->lookahead)) {
      return false;
    }
    array_push(name, lexer->lookahead);
    lexer->advance(lexer, false);
  }
  while (check_name_char(lexer->lookahead)) {
    array_push(name, lexer->lookahead);
    lexer->advance(lexer, false);
  }
  return true;
}

static unsigned check_name(TSLexer *const lexer, const Name *const name) {
  for (unsigned i = 0; i < name->size; ++i) {
    if (lexer->lookahead != name->contents[i]) {
      return i;
    }
    lexer->advance(lexer, false);
  }
  return name->size;
}

static bool check_close_block(TSLexer *const lexer) {
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead != '%') {
    return false;
  }
  lexer->advance(lexer, false);
  return lexer->lookahead == '}';
}

const char inline_chars[] = "inline";

static bool check_inline(TSLexer *const lexer) {
  for (unsigned i = 0; i < sizeof(inline_chars) - 1; ++i) {
    if (lexer->lookahead != inline_chars[i]) {
      return false;
    }
    lexer->advance(lexer, false);
  }
  return check_close_block(lexer);
}

static void skip_horizontal_whitespace(TSLexer *const lexer) {
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    lexer->advance(lexer, false);
  }
}

const char endverbatim_chars[] = "endverbatim";

/* Called right after consuming "{%"; checks whether what follows closes the
 * verbatim block identified by `name` (matching a name on the stack, or, if
 * `name` is empty, an unnamed "{% endverbatim %}"). Consumes input either
 * way, since a failed match still belongs in the verbatim block's raw text. */
static bool check_endverbatim_close(TSLexer *const lexer, const Name *const name) {
  skip_horizontal_whitespace(lexer);
  for (unsigned i = 0; i < sizeof(endverbatim_chars) - 1; ++i) {
    if (lexer->lookahead != endverbatim_chars[i]) {
      return false;
    }
    lexer->advance(lexer, false);
  }
  skip_horizontal_whitespace(lexer);
  if (name->size > 0) {
    for (unsigned i = 0; i < name->size; ++i) {
      if (lexer->lookahead != name->contents[i]) {
        return false;
      }
      lexer->advance(lexer, false);
    }
    if (check_name_char(lexer->lookahead)) {
      return false;
    }
    skip_horizontal_whitespace(lexer);
  }
  if (lexer->lookahead != '%') {
    return false;
  }
  lexer->advance(lexer, false);
  return lexer->lookahead == '}';
}

/* Consumes raw verbatim content up to (but not including) the next tag that
 * closes the innermost open verbatim block, since that content must not be
 * parsed as template syntax. A verbatim block opened with a name is only
 * closed by an "endverbatim" tag bearing the same name, which lets an
 * unrelated (e.g. unnamed) "{% verbatim %}...{% endverbatim %}" pair appear
 * unparsed inside a named verbatim block. */
static bool scan_verbatim_content(struct Scanner *const scanner, TSLexer *const lexer) {
  Stack *stack = get_stack_for_token(scanner, PopVerbatim);
  if (stack->size == 0) {
    return false;
  }
  Name *name = array_back(stack);
  bool consumed_any = false;
  while (true) {
    if (lexer->eof(lexer)) {
      if (!consumed_any) {
        return false;
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = VerbatimContent;
      return true;
    }
    if (lexer->lookahead == '{') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == '%') {
        lexer->advance(lexer, false);
        if (check_endverbatim_close(lexer, name)) {
          if (!consumed_any) {
            return false;
          }
          lexer->result_symbol = VerbatimContent;
          return true;
        }
      }
      consumed_any = true;
      continue;
    }
    lexer->advance(lexer, false);
    consumed_any = true;
  }
}

/* Emits a zero-width token at the whitespace that separates one of the
 * separated_keywords from the token before it. Django splits tag contents on
 * whitespace, so those words are only keywords when something separates them;
 * without this, "{% cycle 1as x %}" would parse as a cycle over 1 bound to x.
 * Two keywords cannot run together (the lexer reads one longer identifier
 * instead), but a literal can run into the keyword after it, and the grammar's
 * extras can never be made mandatory.
 *
 * Reads the whole word that follows and only fires when it is a keyword the
 * parser is currently expecting, since the whitespace after a value is equally
 * the whitespace before another value ("{% cycle a b %}"). */
/* Emits a zero-width token at the end of a literal, and fails when the
 * literal runs straight into whatever follows it. Django splits tag contents
 * on whitespace, so "{% cycle 1a %}" is the single token "1a" and an error,
 * not the number 1 followed by the variable a. A literal ends wherever its
 * own pattern ends, so unlike an identifier it cannot swallow the text after
 * it, which leaves this the only place to catch the run-on. */
static bool scan_after_literal(TSLexer *const lexer) {
  int32_t next = lexer->lookahead;
  if (check_name_char(next) || next == '\'' || next == '"' || next == '-') {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = AfterLiteral;
  return true;
}

static bool scan_separator(TSLexer *const lexer, const bool *const valid_symbols) {
  bool separated = false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    lexer->advance(lexer, true);
    separated = true;
  }
  if (!separated) {
    return false;
  }
  // the token ends here, before the keyword itself, which the grammar lexes
  lexer->mark_end(lexer);

  char word[KEYWORD_SIZE + 1];
  unsigned length = 0;
  while (check_name_char(lexer->lookahead)) {
    if (length == KEYWORD_SIZE) {
      // too long to be one of them, and a prefix match would be wrong anyway
      return false;
    }
    word[length++] = (char) lexer->lookahead;
    lexer->advance(lexer, false);
  }
  word[length] = '\0';

  for (unsigned i = 0; i < KEYWORD_COUNT; ++i) {
    if (valid_symbols[BeforeAnd + i] && strcmp(word, separated_keywords[i]) == 0) {
      lexer->result_symbol = BeforeAnd + i;
      return true;
    }
  }
  return false;
}

const char endcomment_chars[] = "endcomment";

/* Called right after consuming "{%"; checks whether what follows closes the
 * comment block. Unlike verbatim, comment blocks have no name to match and
 * cannot be nested, so any "{% endcomment %}" closes the innermost one. */
static bool check_endcomment_close(TSLexer *const lexer) {
  skip_horizontal_whitespace(lexer);
  for (unsigned i = 0; i < sizeof(endcomment_chars) - 1; ++i) {
    if (lexer->lookahead != endcomment_chars[i]) {
      return false;
    }
    lexer->advance(lexer, false);
  }
  skip_horizontal_whitespace(lexer);
  if (lexer->lookahead != '%') {
    return false;
  }
  lexer->advance(lexer, false);
  return lexer->lookahead == '}';
}

/* Consumes raw comment content up to (but not including) the next
 * "{% endcomment %}", since comment bodies must not be parsed as template
 * syntax even when they happen to contain tag-like text. */
static bool scan_comment_content(TSLexer *const lexer) {
  bool consumed_any = false;
  while (true) {
    if (lexer->eof(lexer)) {
      if (!consumed_any) {
        return false;
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = CommentContent;
      return true;
    }
    if (lexer->lookahead == '{') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == '%') {
        lexer->advance(lexer, false);
        if (check_endcomment_close(lexer)) {
          if (!consumed_any) {
            return false;
          }
          lexer->result_symbol = CommentContent;
          return true;
        }
      }
      consumed_any = true;
      continue;
    }
    lexer->advance(lexer, false);
    consumed_any = true;
  }
}

bool tree_sitter_django_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  struct Scanner *scanner = (struct Scanner*) payload;
  if (scanner->has_error) {
    lexer->log(lexer, "%s", scanner->error);
    if (valid_symbols[MatcherError]) {
      // scanner is an error state, flag problem by returning error token
      lexer->result_symbol = MatcherError;
      return true;
    }
    return false;
  }
  if (valid_symbols[MatcherError]) {
    return false;
  }
  if (valid_symbols[VerbatimContent]) {
    return scan_verbatim_content(scanner, lexer);
  }
  if (valid_symbols[CommentContent]) {
    return scan_comment_content(lexer);
  }
  if (valid_symbols[AfterLiteral]) {
    return scan_after_literal(lexer);
  }
  bool separator = false;
  for (unsigned i = 0; i < KEYWORD_COUNT; ++i) {
    separator |= valid_symbols[BeforeAnd + i];
  }
  if (separator) {
    bool matching_name = false;
    for (unsigned token = PopBlock; token <= PushVerbatim; ++token) {
      matching_name |= valid_symbols[token];
    }
    /* these keywords never follow a tag name that opens or closes a named
     * block, so the two scans never compete over the same position */
    if (!matching_name) {
      return scan_separator(lexer, valid_symbols);
    }
  }
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    lexer->advance(lexer, true);
  }
  bool is_empty = false;
  if (lexer->lookahead == '%') {
    lexer->mark_end(lexer);
    lexer->advance(lexer, false);
    if (lexer->lookahead != '}') {
      return false;
    }
    is_empty = true;
  }

  // save most matched name in case we need to reread characters
  Name *most_matched_name;
  unsigned most_matched_amt = 0;
  for (unsigned token = PopBlock; token < PushBlock; ++token) {
    Stack *stack = get_stack_for_token(scanner, token);
    if (valid_symbols[token] && stack->size > 0) {
      Name *name = array_back(stack);
      if (is_empty) {
        // we matched a close block without an id
        array_delete(name);
        array_pop(stack);
        lexer->result_symbol = token;
        return true;
      }
      if (most_matched_amt > name->size) {
        continue;
      }
      if (most_matched_amt > 0) {
        for (int i = 0; i < most_matched_amt; ++i) {
          if (*array_get(most_matched_name, i) != *array_get(name, i)) {
            continue;
          }
        }
      }
      unsigned match_amt = check_name(lexer, name) + most_matched_amt;
      bool has_next_char = name->size ? check_name_char(lexer->lookahead) : check_name_start_char(lexer->lookahead);
      if (match_amt == name->size && !has_next_char) {
        // name matches and there are no remaining name chars from lexer
        lexer->mark_end(lexer);
        if (check_close_block(lexer)) {
          array_delete(name);
          array_pop(stack);
          lexer->result_symbol = token;
          return true;
        } else {
          // bad close block means no matches
          return false;
        }
      }
      most_matched_amt = match_amt;
      most_matched_name = name;
    }
  }
  for (unsigned token = PushBlock; token <= PushVerbatim; ++token) {
    if (valid_symbols[token]) {
      Stack *stack = get_stack_for_token(scanner, token);
      if (is_empty && token == PushVerbatim) {
        // use empty string for name to indicate empty push
        array_push(stack, (Name) array_new());
        lexer->result_symbol = token;
        return true;
      }
      // do not push stack until we are done with most_matched_name
      Name name = array_new();
      if (most_matched_amt > 0) {
        array_extend(&name, most_matched_amt, most_matched_name);
      }
      if (read_name(lexer, &name)) {
        // validate tokens after name
        lexer->mark_end(lexer);
        if (check_close_block(lexer) || token == PushPartial && check_inline(lexer)) {
          array_push(stack, name);
          lexer->result_symbol = token;
          return true;
        }
      }
      // name was never pushed onto the stack, just free the local copy
      array_delete(&name);
      // single failed push implies failure to match any push
      return false;
    }
  }

  return false;
}
