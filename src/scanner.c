#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include <string.h>

#define ERROR_SIZE 64
#define NAME_SEP ' '

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
};

typedef Array(int32_t) Name;

/* The kinds of tag that open a named region. PushBlock..PushVerbatim and
 * PopBlock..PopVerbatim are declared in this order, so a kind is the offset of
 * its token within either run. */
typedef enum {
  BlockTag,
  PartialTag,
  VerbatimTag,
} TagKind;

/* one letter per kind, in TagKind order, used to serialize an open tag */
static const char tag_kind_chars[] = "bpv";

typedef struct {
  TagKind kind;
  Name name;
} OpenTag;

/* The open tags, innermost last. Only one stack is needed because the grammar
 * nests these regions: a tag can only be closed by the tag that matches the
 * innermost open one, so its pop token is the only one the parser ever asks
 * for at a close tag. */
typedef Array(OpenTag) Stack;

struct Scanner {
  bool has_error;
  union {
    Stack stack;
    char error [ERROR_SIZE];
  };
};

static TagKind kind_for_push(enum TokenType token) {
  return (TagKind) (token - PushBlock);
}

static enum TokenType pop_token_for_kind(TagKind kind) {
  return (enum TokenType) (PopBlock + kind);
}

static void reset_scanner(struct Scanner *const scanner) {
  if (scanner->has_error) {
    scanner->error[0] = '\0';
    scanner->has_error = false;
    // the error shares storage with the stack, which is now meaningless
    memset(&scanner->stack, 0, sizeof(scanner->stack));
  } else {
    for (unsigned i = 0; i < scanner->stack.size; ++i) {
      array_delete(&array_get(&scanner->stack, i)->name);
    }
    array_delete(&scanner->stack);
  }
}

#define scanner_error(scanner, string) do {\
  struct Scanner *_scanner = scanner;\
  reset_scanner(_scanner);\
  _scanner->has_error = true;\
  _scanner->error[0] = '\0';\
  /*strncat(_scanner->error, string, ERROR_SIZE - 1);*/\
} while(0)

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
    // Ok scanner requires copying its stack, as "<kind><name> " per open tag
    for (unsigned i = 0; i < scanner->stack.size; ++i) {
      OpenTag *tag = array_get(&scanner->stack, i);
      iter += write_code(tag_kind_chars[tag->kind], iter);
      for (unsigned j = 0; j < tag->name.size; ++j) {
        int32_t code = *array_get(&tag->name, j);
        unsigned write_amt = write_code(code, iter);
        if (write_amt == 0) {
          scanner_error(scanner, "bad code from name");
          goto write_serialization_error;
        }
        iter += write_amt;
      }
      iter += write_code(NAME_SEP, iter);
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

/* The characters SEP matches in the grammar: whitespace separating the parts
 * of a tag, a newline among them. */
static bool check_space(const int32_t character) {
  return character == ' ' || character == '\t'
      || character == '\n' || character == '\r';
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
      // NULL between tags, and the name being read inside one
      Name *name = NULL;

      while (buffer < end) {
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
        if (name == NULL) {
          // a tag starts with the letter for its kind
          const char *kind = code > 0 && code < 128 ? strchr(tag_kind_chars, code) : NULL;
          if (kind == NULL) {
            scanner_error(scanner, "Invalid tag kind");
            return;
          }
          OpenTag tag = { (TagKind) (kind - tag_kind_chars), array_new() };
          array_push(&scanner->stack, tag);
          name = &array_back(&scanner->stack)->name;
        } else if (code == NAME_SEP) {
          // an empty name means an unnamed tag (e.g. an anonymous verbatim)
          name = NULL;
        } else {
          bool valid = name->size ? check_name_char(code) : check_name_start_char(code);
          if (!valid) {
            scanner_error(scanner, "Invalid character in name");
            return;
          }
          array_push(name, code);
        }
      }
      if (name != NULL) {
        scanner_error(scanner, "Scanner deserialization finished mid-name");
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
  while (check_space(lexer->lookahead)) {
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead != '%') {
    return false;
  }
  lexer->advance(lexer, false);
  return lexer->lookahead == '}';
}

/* Marks the name just read as the token, then checks that only "%}" follows. */
static bool check_close_block_from(TSLexer *const lexer) {
  lexer->mark_end(lexer);
  return check_close_block(lexer);
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

static void skip_whitespace(TSLexer *const lexer) {
  while (check_space(lexer->lookahead)) {
    lexer->advance(lexer, false);
  }
}

const char endverbatim_chars[] = "endverbatim";

/* Called right after consuming "{%"; checks whether what follows closes the
 * verbatim block identified by `name` (matching a name on the stack, or, if
 * `name` is empty, an unnamed "{% endverbatim %}"). Consumes input either
 * way, since a failed match still belongs in the verbatim block's raw text. */
static bool check_endverbatim_close(TSLexer *const lexer, const Name *const name) {
  skip_whitespace(lexer);
  for (unsigned i = 0; i < sizeof(endverbatim_chars) - 1; ++i) {
    if (lexer->lookahead != endverbatim_chars[i]) {
      return false;
    }
    lexer->advance(lexer, false);
  }
  skip_whitespace(lexer);
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
    skip_whitespace(lexer);
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
  if (scanner->stack.size == 0) {
    return false;
  }
  OpenTag *tag = array_back(&scanner->stack);
  if (tag->kind != VerbatimTag) {
    return false;
  }
  Name *name = &tag->name;
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

const char endcomment_chars[] = "endcomment";

/* Called right after consuming "{%"; checks whether what follows closes the
 * comment block. Unlike verbatim, comment blocks have no name to match and
 * cannot be nested, so any "{% endcomment %}" closes the innermost one. */
static bool check_endcomment_close(TSLexer *const lexer) {
  skip_whitespace(lexer);
  for (unsigned i = 0; i < sizeof(endcomment_chars) - 1; ++i) {
    if (lexer->lookahead != endcomment_chars[i]) {
      return false;
    }
    lexer->advance(lexer, false);
  }
  skip_whitespace(lexer);
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
  while (check_space(lexer->lookahead)) {
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

  /* Only the innermost open tag can be closed here, so it is the one and only
   * candidate: there is never a second name to try, and so never any input to
   * reread. */
  if (scanner->stack.size > 0) {
    OpenTag *tag = array_back(&scanner->stack);
    enum TokenType token = pop_token_for_kind(tag->kind);
    if (valid_symbols[token]) {
      if (is_empty) {
        // we matched a close block without an id
        array_delete(&tag->name);
        array_pop(&scanner->stack);
        lexer->result_symbol = token;
        return true;
      }
      unsigned match_amt = check_name(lexer, &tag->name);
      bool has_next_char = tag->name.size ? check_name_char(lexer->lookahead) : check_name_start_char(lexer->lookahead);
      if (match_amt == tag->name.size && !has_next_char && check_close_block_from(lexer)) {
        array_delete(&tag->name);
        array_pop(&scanner->stack);
        lexer->result_symbol = token;
        return true;
      }
      // the close tag names something other than the tag it would close
      return false;
    }
  }
  for (unsigned token = PushBlock; token <= PushVerbatim; ++token) {
    if (valid_symbols[token]) {
      TagKind kind = kind_for_push(token);
      if (is_empty && token == PushVerbatim) {
        // use empty string for name to indicate empty push
        OpenTag tag = { kind, array_new() };
        array_push(&scanner->stack, tag);
        lexer->result_symbol = token;
        return true;
      }
      Name name = array_new();
      if (read_name(lexer, &name)) {
        // validate tokens after name
        lexer->mark_end(lexer);
        if (check_close_block(lexer) || token == PushPartial && check_inline(lexer)) {
          OpenTag tag = { kind, name };
          array_push(&scanner->stack, tag);
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
