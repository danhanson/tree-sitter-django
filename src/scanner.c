#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"

#define ERROR_SIZE 64
#define NAME_SEP ' '

/* A scanner is also built for Wasm, where only a few C library functions are
 * available and string.h is not among them, so strings are compared here. */
static bool strings_equal(const char *left, const char *right) {
  while (*left != '\0' && *left == *right) {
    ++left;
    ++right;
  }
  return *left == *right;
}

enum TokenType {
  /* indicates that an error occurred */
  MatcherError,
  /* check a close tag's name against the innermost open group */
  PopBlock,     // [ name ] %}
  PopPartial,   // [ name ] %}
  PopVerbatim,  // [ name ] %}
  /* read the name an opening tag gives its group */
  PushBlock,    // name %}
  PushPartial,  // name [ inline ] %}
  PushVerbatim, // [ name ] %}
  /* raw text inside a verbatim block, up through (but excluding) the matching endverbatim tag */
  VerbatimContent,
  /* raw text inside a comment block, up through (but excluding) the endcomment tag */
  CommentContent,
  /* zero width, at the start of a tag: forget what the tag before it held */
  TagOpen,
  /* zero width, before an option of a blocktranslate tag: record it, and fail
   * if that option has already been written once */
  TranslateOption,
  /* zero width, before the name of a "name=value" argument: record the name,
   * and fail if the tag has already been given one by that name */
  KwargName,
  /* zero width, where a tag group's required tag is missing; see
   * scan_missing_block */
  MissingBlock,
  /* zero width, after "{%": read the tag's name */
  GroupOpenTagRead,
  /* zero width, before the "%}" of a tag that opens a group: push the group */
  GroupOpenTagPush,
  /* zero width, before the "%}" of a middle tag a group holds once, such as
   * "else": record that the group holds it */
  GroupFollow,
  /* zero width, before the "%}" of a middle tag a group may hold any number of
   * times, such as "elif" */
  GroupRepeat,
  /* zero width, before the "%}" of a tag that closes a group: pop the group */
  GroupClose,
  /* zero width, before the "%}" of an unexpected_block: returned only when
   * the innermost group already holds a tag by that name, which makes this the
   * likelier stray of the two */
  GroupHeld,
};

/* The options blocktranslate takes, in the order of the bits recording them.
 * do_block_translate keeps the ones it has seen in a dict and refuses a repeat,
 * so a bit per option is the whole of the state this needs. */
static const char *const translate_options[] = {
  "with", "count", "context", "trimmed", "asvar",
};

/* the index of "count" in translate_options */
#define TRANSLATE_COUNT 1

typedef Array(int32_t) Name;

/* An open tag group. The scanner knows nothing about any particular group: the
 * grammar reads each tag's name to it, and every group is closed by "end"
 * followed by the name of the tag that opened it. */
typedef struct {
  /* the name of the tag that closes the group */
  Name expected;
  /* the name a block, partialdef or verbatim tag gave the group, or empty */
  Name name;
  /* the middle tags the group may hold only once and already holds, such as
   * "else", each followed by NAME_SEP */
  Name middles;
  /* a counted blocktranslate, whose plural is still to come */
  bool awaits_plural;
} OpenGroup;

/* The open groups, innermost last. The grammar nests them, so only the
 * innermost can be closed. */
typedef Array(OpenGroup) Stack;

struct Scanner {
  bool has_error;
  /* Everything below is readable only while has_error is false: the error
   * string shares its storage with all of it.
   *
   * translate_seen holds one bit per option of the blocktranslate tag being
   * read, by the order of translate_options. seen_kwargs holds the
   * "name=value" argument names the tag has been given, each followed by
   * NAME_SEP: parse_bits refuses a repeated keyword argument and the set of
   * names is open, so the names are kept rather than a mask of known ones.
   *
   * read_word is the name of the tag being read, pending_name the name its
   * push token read (for block, partialdef and verbatim), and pending_plural
   * whether it is a counted blocktranslate; all three wait for the tag's end,
   * where GroupOpenTagPush turns them into an open group. */
  union {
    struct {
      uint8_t translate_seen;
      bool pending_plural;
      Name seen_kwargs;
      Name read_word;
      Name pending_name;
      Stack stack;
    };
    char error [ERROR_SIZE];
  };
};

static void delete_group(OpenGroup *const group) {
  array_delete(&group->expected);
  array_delete(&group->name);
  array_delete(&group->middles);
}

static void pop_group(struct Scanner *const scanner) {
  delete_group(array_back(&scanner->stack));
  array_pop(&scanner->stack);
}

static void reset_scanner(struct Scanner *const scanner) {
  if (scanner->has_error) {
    /* The error shares its storage with the state below, so none of that is
     * readable here and none of it holds a pointer to free: scanner_error
     * resets before it sets has_error, which is what frees them. Zeroing the
     * whole struct clears the error and the state it overlays at once. */
    *scanner = (struct Scanner) {0};
  } else {
    scanner->translate_seen = 0;
    scanner->pending_plural = false;
    array_delete(&scanner->seen_kwargs);
    array_delete(&scanner->read_word);
    array_delete(&scanner->pending_name);
    for (unsigned i = 0; i < scanner->stack.size; ++i) {
      delete_group(array_get(&scanner->stack, i));
    }
    array_delete(&scanner->stack);
  }
}

/* The size of a name copied into a log message, its terminator included. */
#define LOG_NAME_SIZE 64

/* Copies a name into `out` for a log message, cut short to fit it. A name holds
 * only ASCII letters, digits and underscores, so each code point is one char. */
static const char *log_name(const Name *const name, char out[LOG_NAME_SIZE]) {
  unsigned i = 0;
  for (; i < name->size && i < LOG_NAME_SIZE - 1; ++i) {
    out[i] = (char) name->contents[i];
  }
  out[i] = '\0';
  return out;
}

/* Copies `string` into the error, cut short to fit it. */
static void set_error(struct Scanner *const scanner, const char *const string) {
  unsigned i = 0;
  for (; i < ERROR_SIZE - 1 && string[i] != '\0'; ++i) {
    scanner->error[i] = string[i];
  }
  scanner->error[i] = '\0';
}

#define scanner_error(scanner, string) do {\
  struct Scanner *_scanner = scanner;\
  reset_scanner(_scanner);\
  _scanner->has_error = true;\
  set_error(_scanner, string);\
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

/* Writes one code point, or reports that it is invalid or would not fit before
 * `end`: a stack of open groups holds whole names, so a deep enough nesting
 * outgrows the buffer tree-sitter serializes into. */
static bool write_checked(const int32_t code, char **const iter, const char *const end) {
  if (end - *iter < 4) {
    return false;
  }
  const unsigned write_amt = write_code(code, *iter);
  if (write_amt == 0) {
    return false;
  }
  *iter += write_amt;
  return true;
}

static bool write_name(const Name *const name, char **const iter, const char *const end) {
  for (unsigned i = 0; i < name->size; ++i) {
    if (!write_checked(name->contents[i], iter, end)) {
      return false;
    }
  }
  return true;
}

/* The state is written as:
 *
 *   status  "0", or "1" for an error state, which is followed by the error
 *   mask    translate_seen, as a character from '0'
 *   plural  pending_plural, '0' or '1'
 *   seen_kwargs "\n" read_word "\n" pending_name "\n"
 *   then per open group, outermost first:
 *     expected ":" name ":" middles ":" awaits_plural "\n"
 *
 * No name holds a newline or a colon, so neither needs escaping. */
unsigned tree_sitter_django_external_scanner_serialize(
  void *payload,
  char *const buffer
) {
  struct Scanner *scanner = (struct Scanner*) payload;
  const char *const end = buffer + TREE_SITTER_SERIALIZATION_BUFFER_SIZE;

write_serialization_error:;
  char *iter = buffer;
  if (scanner->has_error) {
    *(iter++) = '1';
    for (int i = 0; i < ERROR_SIZE; ++i) {
      char value = scanner->error[i];
      *(iter++) = value;
      if (value == '\0') {
        break;
      }
    }
    return iter - buffer;
  }
  bool written = write_checked('0', &iter, end)
    // five options fit in five bits, which stays inside printable ASCII
    && write_checked(scanner->translate_seen + '0', &iter, end)
    && write_checked(scanner->pending_plural ? '1' : '0', &iter, end)
    && write_name(&scanner->seen_kwargs, &iter, end)
    && write_checked('\n', &iter, end)
    && write_name(&scanner->read_word, &iter, end)
    && write_checked('\n', &iter, end)
    && write_name(&scanner->pending_name, &iter, end)
    && write_checked('\n', &iter, end);
  for (unsigned i = 0; written && i < scanner->stack.size; ++i) {
    const OpenGroup *const group = array_get(&scanner->stack, i);
    written = write_name(&group->expected, &iter, end)
      && write_checked(':', &iter, end)
      && write_name(&group->name, &iter, end)
      && write_checked(':', &iter, end)
      && write_name(&group->middles, &iter, end)
      && write_checked(':', &iter, end)
      && write_checked(group->awaits_plural ? '1' : '0', &iter, end)
      && write_checked('\n', &iter, end);
  }
  if (!written) {
    scanner_error(scanner, "the open groups do not fit the serialization buffer");
    goto write_serialization_error;
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

/* Reads one code point of the serialized state, or reports that none is left. */
static bool read_checked(const char **const iter, const char *const end, int32_t *const code) {
  if (*iter >= end) {
    return false;
  }
  const unsigned bytes_read = read_code(*iter, code);
  if (bytes_read == 0 || (unsigned) (end - *iter) < bytes_read) {
    return false;
  }
  *iter += bytes_read;
  return true;
}

/* Reads name characters, and NAME_SEP where `separated`, up to `terminator`. */
static bool read_field(
  const char **const iter,
  const char *const end,
  Name *const out,
  const int32_t terminator,
  const bool separated
) {
  int32_t code;
  for (;;) {
    if (!read_checked(iter, end, &code)) {
      return false;
    }
    if (code == terminator) {
      return true;
    }
    if (!check_name_char(code) && !(separated && code == NAME_SEP)) {
      return false;
    }
    array_push(out, code);
  }
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
  const char *iter = buffer;
  const char *const end = buffer + length;
  int32_t status;
  if (!read_checked(&iter, end, &status)) {
    scanner_error(scanner, "received invalid utf8 byte");
    return;
  }
  if (status == '1') {
    scanner->has_error = true;
    unsigned i = 0;
    for (; i < ERROR_SIZE - 1 && iter < end && *iter != '\0'; ++i) {
      scanner->error[i] = *(iter++);
    }
    scanner->error[i] = '\0';
    return;
  }
  int32_t mask;
  int32_t plural;
  if (status != '0' || !read_checked(&iter, end, &mask) || !read_checked(&iter, end, &plural)) {
    scanner_error(scanner, "received unrecognized scanner status");
    return;
  }
  if (mask < '0' || mask > '0' + 0x1F || (plural != '0' && plural != '1')) {
    scanner_error(scanner, "received unrecognized option mask");
    return;
  }
  scanner->translate_seen = (uint8_t) (mask - '0');
  scanner->pending_plural = plural == '1';
  if (!read_field(&iter, end, &scanner->seen_kwargs, '\n', true)
      || !read_field(&iter, end, &scanner->read_word, '\n', false)
      || !read_field(&iter, end, &scanner->pending_name, '\n', false)) {
    scanner_error(scanner, "received invalid tag names");
    return;
  }
  while (iter < end) {
    OpenGroup group = { array_new(), array_new(), array_new(), false };
    int32_t awaits_plural;
    int32_t newline;
    const bool read = read_field(&iter, end, &group.expected, ':', false)
      && read_field(&iter, end, &group.name, ':', false)
      && read_field(&iter, end, &group.middles, ':', true)
      && read_checked(&iter, end, &awaits_plural)
      && (awaits_plural == '0' || awaits_plural == '1')
      && read_checked(&iter, end, &newline)
      && newline == '\n';
    if (!read) {
      delete_group(&group);
      scanner_error(scanner, "received an invalid open group");
      return;
    }
    group.awaits_plural = awaits_plural == '1';
    array_push(&scanner->stack, group);
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

/* The longest name in translate_options, "context" and "trimmed", is 7. */
#define TRANSLATE_OPTION_MAX 8

/* Reads the word naming a blocktranslate option and returns its index, or -1
 * for anything else, which includes the end of the tag. Consumes nothing the
 * caller keeps: it is called after the end has been marked. */
static int read_translate_option(TSLexer *const lexer) {
  char word[TRANSLATE_OPTION_MAX + 1];
  unsigned size = 0;
  if (!check_name_start_char(lexer->lookahead)) {
    return -1;
  }
  while (check_name_char(lexer->lookahead)) {
    if (size < TRANSLATE_OPTION_MAX) {
      word[size] = (char) lexer->lookahead;
    }
    ++size;
    lexer->advance(lexer, false);
  }
  if (size > TRANSLATE_OPTION_MAX) {
    return -1;
  }
  word[size] = '\0';
  for (unsigned i = 0; i < sizeof(translate_options) / sizeof(*translate_options); ++i) {
    if (strings_equal(word, translate_options[i])) {
      return (int) i;
    }
  }
  return -1;
}

/* Scans TranslateOption once its whitespace is skipped and the end marked. */
static bool scan_translate_option(struct Scanner *const scanner, TSLexer *const lexer) {
  const int option = read_translate_option(lexer);
  if (option < 0) {
    return false;
  }
  const uint8_t bit = (uint8_t) (1 << option);
  if (scanner->translate_seen & bit) {
    lexer->log(lexer, "refused blocktranslate option %s: it is already written once in this tag",
      translate_options[option]);
    return false;
  }
  scanner->translate_seen |= bit;
  if (option == TRANSLATE_COUNT) {
    // the group this tag pushes waits for a plural before its end tag
    scanner->pending_plural = true;
  }
  lexer->result_symbol = TranslateOption;
  return true;
}

/* Reads the name of a "name=value" argument, and reports whether the tag can
 * still take it. A name not followed by "=" is not one of these arguments at
 * all, which is what tells this apart from the "as name" clause or the end of
 * the tag; the name is only kept once the "=" has been seen.
 *
 * The names are held end to end, each followed by NAME_SEP, which no name
 * holds. The candidate is appended first and dropped again if it turns out to
 * be a repeat, so nothing is kept unless the token is returned. */
static bool scan_kwarg_name(struct Scanner *const scanner, TSLexer *const lexer) {
  if (!check_name_start_char(lexer->lookahead)) {
    return false;
  }
  const unsigned start = scanner->seen_kwargs.size;
  while (check_name_char(lexer->lookahead)) {
    array_push(&scanner->seen_kwargs, lexer->lookahead);
    lexer->advance(lexer, false);
  }
  const unsigned size = scanner->seen_kwargs.size - start;
  if (lexer->lookahead != '=') {
    scanner->seen_kwargs.size = start;
    return false;
  }
  for (unsigned i = 0; i < start;) {
    unsigned end = i;
    while (end < start && *array_get(&scanner->seen_kwargs, end) != NAME_SEP) {
      ++end;
    }
    if (end - i == size) {
      bool same = true;
      for (unsigned j = 0; j < size; ++j) {
        if (*array_get(&scanner->seen_kwargs, i + j)
            != *array_get(&scanner->seen_kwargs, start + j)) {
          same = false;
          break;
        }
      }
      if (same) {
        const Name name = { array_get(&scanner->seen_kwargs, start), size, size };
        char buffer[LOG_NAME_SIZE];
        lexer->log(lexer, "refused keyword argument %s: the tag already holds one by that name",
          log_name(&name, buffer));
        scanner->seen_kwargs.size = start;
        return false;
      }
    }
    i = end + 1;
  }
  array_push(&scanner->seen_kwargs, NAME_SEP);
  return true;
}

static bool names_equal(const Name *const left, const Name *const right) {
  if (left->size != right->size) {
    return false;
  }
  for (unsigned i = 0; i < left->size; ++i) {
    if (left->contents[i] != right->contents[i]) {
      return false;
    }
  }
  return true;
}

static bool name_is(const Name *const name, const char *const string) {
  unsigned i = 0;
  for (; i < name->size; ++i) {
    if (string[i] == '\0' || name->contents[i] != string[i]) {
      return false;
    }
  }
  return string[i] == '\0';
}

/* Whether `word` is one of the names in `list`, each followed by NAME_SEP. */
static bool name_in_list(const Name *const word, const Name *const list) {
  unsigned start = 0;
  for (unsigned i = 0; i < list->size; ++i) {
    if (list->contents[i] != NAME_SEP) {
      continue;
    }
    if (i - start == word->size) {
      bool same = true;
      for (unsigned j = 0; j < word->size; ++j) {
        if (list->contents[start + j] != word->contents[j]) {
          same = false;
          break;
        }
      }
      if (same) {
        return true;
      }
    }
    start = i + 1;
  }
  return false;
}

/* Whether a tag named `word` closes a group enclosing the innermost one. */
static bool outer_group_expects(const struct Scanner *const scanner, const Name *const word) {
  for (unsigned i = scanner->stack.size - 1; i-- > 0;) {
    if (names_equal(&array_get(&scanner->stack, i)->expected, word)) {
      return true;
    }
  }
  return false;
}

/* Reads a tag's name, which may be empty. */
static void read_word(TSLexer *const lexer, Name *const word) {
  while (check_name_char(lexer->lookahead)) {
    array_push(word, lexer->lookahead);
    lexer->advance(lexer, false);
  }
}

/* Scans GroupOpenTagRead, zero width after "{%": records the name of the tag
 * that follows for the tokens at its end, and forgets what the tag before it
 * left there. It is valid before every tag's name, so it is always returned. */
static void scan_group_open_tag_read(struct Scanner *const scanner, TSLexer *const lexer) {
  lexer->mark_end(lexer);
  array_clear(&scanner->read_word);
  array_clear(&scanner->pending_name);
  scanner->pending_plural = false;
  skip_whitespace(lexer);
  read_word(lexer, &scanner->read_word);
  lexer->result_symbol = GroupOpenTagRead;
}

/* Scans GroupOpenTagPush, GroupFollow, GroupRepeat, GroupHeld or GroupClose,
 * once "%}" has been found to follow. */
static bool scan_group_tag_end(
  struct Scanner *const scanner,
  TSLexer *const lexer,
  const bool *const valid_symbols
) {
  char buffer[LOG_NAME_SIZE];
  if (valid_symbols[GroupOpenTagPush]) {
    OpenGroup group = {
      array_new(), scanner->pending_name, array_new(), scanner->pending_plural,
    };
    scanner->pending_name = (Name) array_new();
    scanner->pending_plural = false;
    array_push(&group.expected, 'e');
    array_push(&group.expected, 'n');
    array_push(&group.expected, 'd');
    for (unsigned i = 0; i < scanner->read_word.size; ++i) {
      array_push(&group.expected, scanner->read_word.contents[i]);
    }
    array_push(&scanner->stack, group);
    lexer->result_symbol = GroupOpenTagPush;
    return true;
  }
  if (valid_symbols[GroupFollow]) {
    if (scanner->stack.size == 0) {
      lexer->log(lexer, "not recording %s: the parser is inside a group, but the stack holds none",
        log_name(&scanner->read_word, buffer));
    } else {
      OpenGroup *const group = array_back(&scanner->stack);
      if (name_in_list(&scanner->read_word, &group->middles)) {
        // a second one of these parses as an unexpected_block, which has no follow
        lexer->log(lexer, "refused %s: the parser gives it to the innermost group, which already holds one",
          log_name(&scanner->read_word, buffer));
        return false;
      }
      for (unsigned i = 0; i < scanner->read_word.size; ++i) {
        array_push(&group->middles, scanner->read_word.contents[i]);
      }
      array_push(&group->middles, NAME_SEP);
      if (name_is(&scanner->read_word, "plural")) {
        group->awaits_plural = false;
      }
    }
    lexer->result_symbol = GroupFollow;
    return true;
  }
  if (valid_symbols[GroupRepeat]) {
    lexer->result_symbol = GroupRepeat;
    return true;
  }
  if (valid_symbols[GroupHeld]) {
    if (scanner->stack.size == 0
        || !name_in_list(&scanner->read_word, &array_back(&scanner->stack)->middles)) {
      return false;
    }
    lexer->result_symbol = GroupHeld;
    return true;
  }
  if (!valid_symbols[GroupClose]) {
    return false;
  }
  if (scanner->stack.size == 0) {
    lexer->log(lexer, "refused %s: the parser expects a group to close, but the stack holds none",
      log_name(&scanner->read_word, buffer));
    return false;
  }
  const OpenGroup *const group = array_back(&scanner->stack);
  if (!names_equal(&group->expected, &scanner->read_word) || group->awaits_plural) {
    char expected[LOG_NAME_SIZE];
    lexer->log(lexer, "refused %s: the parser expects a group to close, but the innermost on the stack %s %s",
      log_name(&scanner->read_word, buffer),
      group->awaits_plural ? "still waits for the plural before" : "closes with",
      log_name(&group->expected, expected));
    return false;
  }
  pop_group(scanner);
  lexer->result_symbol = GroupClose;
  return true;
}

typedef enum {
  /* no marker here, and nothing has been read */
  NotMissing,
  /* the marker was scanned */
  Missing,
  /* no marker, but input was read to decide that, so nothing else may be
   * scanned from here */
  NotMissingAfterReading,
} MissingResult;

/* Scans the zero-width marker for the innermost group's missing tag. The
 * marker is valid only where that group could close, which is after a body,
 * where nothing else of this scanner is valid but the raw-text tokens, and
 * those are scanned only when this returns NotMissing.
 *
 * The tag is taken to be missing at the end of input; before the end tag of a
 * group enclosing the innermost one, or an endblock or endpartialdef naming a
 * block further out; and before a second plural, since a blocktranslate body
 * holds no tag that could take it. Any other tag is taken to be the innermost
 * group's, as Django takes it: a second of a tag the group holds only once, such
 * as a second "else", is an unexpected_block inside the group rather than a sign
 * that it has ended. A counted blocktranslate still waiting for its plural is
 * missing it before anything but "plural". The marker closes the group as the
 * missing tag would have, or for a plural records it, leaving the group open. */
static MissingResult scan_missing_block(
  struct Scanner *const scanner,
  TSLexer *const lexer,
  const bool *const valid_symbols
) {
  if (scanner->stack.size == 0) {
    // the marker is only valid inside a group, so the stack has lost track of it
    lexer->log(lexer, "no missing-tag marker: the parser is inside a group, but the stack holds none");
    return NotMissing;
  }
  OpenGroup *const innermost = array_back(&scanner->stack);
  lexer->mark_end(lexer);
  if (!lexer->eof(lexer)) {
    // tags are not read in a raw body, so only the end of input shows its end is missing
    const bool raw = valid_symbols[VerbatimContent] || valid_symbols[CommentContent];
    if (raw || lexer->lookahead != '{') {
      return NotMissing;
    }
    lexer->advance(lexer, false);
    if (lexer->lookahead != '%') {
      return NotMissingAfterReading;
    }
    lexer->advance(lexer, false);
    skip_whitespace(lexer);
    Name word = array_new();
    read_word(lexer, &word);
    bool missing = false;
    if (word.size == 0) {
      missing = false;
    } else if (innermost->awaits_plural) {
      missing = !name_is(&word, "plural")
        && (names_equal(&innermost->expected, &word) || outer_group_expects(scanner, &word));
    } else if (names_equal(&innermost->expected, &word)) {
      // the group's own end tag, unless it names a block further out
      if (innermost->name.size > 0 && check_space(lexer->lookahead) && scanner->stack.size > 1) {
        skip_whitespace(lexer);
        Name name = array_new();
        if (read_name(lexer, &name) && !names_equal(&innermost->name, &name)) {
          for (unsigned i = scanner->stack.size - 1; i-- > 0;) {
            const OpenGroup *const group = array_get(&scanner->stack, i);
            if (names_equal(&group->expected, &word) && names_equal(&group->name, &name)) {
              missing = true;
              break;
            }
          }
        }
        array_delete(&name);
      }
    } else if (name_in_list(&word, &innermost->middles)) {
      // a second of a tag the group holds only once is an unexpected_block in it
      missing = name_is(&word, "plural");
    } else {
      missing = outer_group_expects(scanner, &word);
    }
    array_delete(&word);
    if (!missing) {
      return NotMissingAfterReading;
    }
  }
  if (innermost->awaits_plural) {
    innermost->awaits_plural = false;
  } else {
    pop_group(scanner);
  }
  lexer->result_symbol = MissingBlock;
  return Missing;
}

/* Called right after consuming "{%"; checks whether what follows is the tag
 * that closes `group`: its end tag, with the group's name if it has one. Consumes
 * input either way, since a failed match still belongs in the raw text. */
static bool check_group_close(TSLexer *const lexer, const OpenGroup *const group) {
  skip_whitespace(lexer);
  if (check_name(lexer, &group->expected) != group->expected.size) {
    return false;
  }
  skip_whitespace(lexer);
  if (group->name.size > 0) {
    if (check_name(lexer, &group->name) != group->name.size || check_name_char(lexer->lookahead)) {
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

/* Consumes the raw body of the innermost group, verbatim or comment, up to
 * (but not including) the tag that closes it, since that text must not be
 * parsed as template syntax. A verbatim block opened with a name is only closed
 * by an "endverbatim" tag bearing the same name, which lets an unrelated (e.g.
 * unnamed) "{% verbatim %}...{% endverbatim %}" pair appear inside it. */
static bool scan_raw_content(
  struct Scanner *const scanner,
  TSLexer *const lexer,
  const enum TokenType token
) {
  if (scanner->stack.size == 0) {
    return false;
  }
  const OpenGroup *const group = array_back(&scanner->stack);
  bool consumed_any = false;
  while (true) {
    if (lexer->eof(lexer)) {
      if (!consumed_any) {
        return false;
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = token;
      return true;
    }
    if (lexer->lookahead == '{') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == '%') {
        lexer->advance(lexer, false);
        if (check_group_close(lexer, group)) {
          if (!consumed_any) {
            return false;
          }
          lexer->result_symbol = token;
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
  /* The zero-width tokens below belong here: above the raw-text scanners,
   * which find nothing at the end of an empty body, above the loop further
   * down, which skips the separator the grammar still has to match, and below
   * the MatcherError check, which keeps them from being scanned during error
   * recovery. */
  if (valid_symbols[MissingBlock]) {
    switch (scan_missing_block(scanner, lexer, valid_symbols)) {
      case Missing:
        return true;
      case NotMissingAfterReading:
        return false;
      case NotMissing:
        break;
    }
  }
  if (valid_symbols[GroupOpenTagRead]) {
    scan_group_open_tag_read(scanner, lexer);
    return true;
  }
  if (valid_symbols[GroupOpenTagPush] || valid_symbols[GroupFollow]
      || valid_symbols[GroupRepeat] || valid_symbols[GroupClose]
      || valid_symbols[GroupHeld]) {
    lexer->mark_end(lexer);
    const bool spaced = check_space(lexer->lookahead);
    skip_whitespace(lexer);
    if (lexer->lookahead == '%') {
      lexer->advance(lexer, false);
      return lexer->lookahead == '}' && scan_group_tag_end(scanner, lexer, valid_symbols);
    }
    // a blocktranslate option may be written where its tag could also end
    if (spaced && valid_symbols[TranslateOption]) {
      return scan_translate_option(scanner, lexer);
    }
    return false;
  }
  if (valid_symbols[VerbatimContent]) {
    return scan_raw_content(scanner, lexer, VerbatimContent);
  }
  if (valid_symbols[CommentContent]) {
    return scan_raw_content(scanner, lexer, CommentContent);
  }
  if (valid_symbols[TagOpen]) {
    lexer->mark_end(lexer);
    scanner->translate_seen = 0;
    array_delete(&scanner->seen_kwargs);
    lexer->result_symbol = TagOpen;
    return true;
  }
  if (valid_symbols[KwargName]) {
    lexer->mark_end(lexer);
    if (!scan_kwarg_name(scanner, lexer)) {
      return false;
    }
    lexer->result_symbol = KwargName;
    return true;
  }
  if (valid_symbols[TranslateOption]) {
    lexer->mark_end(lexer);
    if (!check_space(lexer->lookahead)) {
      return false;
    }
    skip_whitespace(lexer);
    return scan_translate_option(scanner, lexer);
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

  /* A close tag's name is checked against the innermost open group, the only
   * one it can close; GroupClose, at the end of the tag, is what pops it. */
  for (unsigned token = PopBlock; token <= PopVerbatim; ++token) {
    if (!valid_symbols[token]) {
      continue;
    }
    char buffer[LOG_NAME_SIZE];
    if (scanner->stack.size == 0) {
      lexer->log(lexer, "refused a close tag's name: the parser expects a group to close, but the stack holds none");
      return false;
    }
    const OpenGroup *const group = array_back(&scanner->stack);
    if (is_empty) {
      // a close tag without a name closes the innermost group whatever its name
      lexer->result_symbol = token;
      return true;
    }
    const unsigned match_amt = check_name(lexer, &group->name);
    const bool has_next_char = group->name.size ? check_name_char(lexer->lookahead) : check_name_start_char(lexer->lookahead);
    if (match_amt == group->name.size && !has_next_char && check_close_block_from(lexer)) {
      lexer->result_symbol = token;
      return true;
    }
    char expected[LOG_NAME_SIZE];
    lexer->log(lexer, "refused %s: it does not name the innermost open \"%s\"",
      log_name(&group->expected, expected), log_name(&group->name, buffer));
    return false;
  }
  for (unsigned token = PushBlock; token <= PushVerbatim; ++token) {
    if (!valid_symbols[token]) {
      continue;
    }
    if (is_empty && token == PushVerbatim) {
      // an unnamed verbatim block, whose group GroupOpenTagPush pushes nameless
      array_clear(&scanner->pending_name);
      lexer->result_symbol = token;
      return true;
    }
    Name name = array_new();
    if (read_name(lexer, &name)) {
      // validate tokens after name
      lexer->mark_end(lexer);
      if (check_close_block(lexer) || token == PushPartial && check_inline(lexer)) {
        array_delete(&scanner->pending_name);
        scanner->pending_name = name;
        lexer->result_symbol = token;
        return true;
      }
    }
    array_delete(&name);
    // single failed push implies failure to match any push
    return false;
  }

  return false;
}
