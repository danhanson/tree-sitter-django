import XCTest
import SwiftTreeSitter
import TreeSitterDjango

final class TreeSitterDjangoTests: XCTestCase {
    func testCanLoadGrammar() throws {
        let parser = Parser()
        let language = Language(language: tree_sitter_django())
        XCTAssertNoThrow(try parser.setLanguage(language),
                         "Error loading Django Parser grammar")
    }
}
