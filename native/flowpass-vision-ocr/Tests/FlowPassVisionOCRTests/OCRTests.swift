import XCTest
@testable import FlowPassVisionOCRCore

final class OCRTests: XCTestCase {
  func testEmptyInputIsRejectedWithoutAPath() {
    XCTAssertThrowsError(try VisionOCRProcessor().recognize(data: Data()))
  }
}
