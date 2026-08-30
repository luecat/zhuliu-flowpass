import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Vision

public struct OCRBoundingBox: Codable, Equatable {
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double
}

public struct OCRLine: Codable, Equatable {
  public let page: Int
  public let text: String
  public let confidence: Double
  public let boundingBox: OCRBoundingBox
}

public struct OCRResult: Codable, Equatable {
  public let engine: String
  public let engineVersion: String
  public let languages: [String]
  public let lines: [OCRLine]
  public let durationMs: Int
}

public enum VisionOCRError: Error {
  case emptyInput
  case unsupportedDocument
  case invalidImage
  case invalidPdf
  case tooManyPages
  case tooManyPixels
}

public final class VisionOCRProcessor {
  public static let maxPages = 10
  public static let maxPixels = 36_000_000
  private let dpi: CGFloat = 200

  public init() {}

  public func recognize(data: Data) throws -> OCRResult {
    guard !data.isEmpty else { throw VisionOCRError.emptyInput }
    let started = DispatchTime.now().uptimeNanoseconds
    let pages = try rasterize(data: data)
    let supported = (try? VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: VNRecognizeTextRequest.currentRevision)) ?? []
    let languages = ["zh-Hant", "en-US"].filter { supported.contains($0) }
    var lines: [OCRLine] = []
    for (index, image) in pages.enumerated() {
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = false
      request.recognitionLanguages = languages
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      try handler.perform([request])
      for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty else { continue }
        let box = observation.boundingBox
        lines.append(OCRLine(page: index + 1, text: candidate.string, confidence: Double(candidate.confidence), boundingBox: OCRBoundingBox(x: Double(box.origin.x), y: Double(box.origin.y), width: Double(box.size.width), height: Double(box.size.height))))
      }
    }
    let elapsed = Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
    return OCRResult(engine: "vision", engineVersion: "VNRecognizeTextRequest-\(VNRecognizeTextRequest.currentRevision)", languages: languages, lines: lines, durationMs: elapsed)
  }

  private func rasterize(data: Data) throws -> [CGImage] {
    if data.prefix(5) == Data("%PDF-".utf8) { return try rasterizePDF(data: data) }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw VisionOCRError.invalidImage }
    if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
       let width = properties[kCGImagePropertyPixelWidth] as? Int,
       let height = properties[kCGImagePropertyPixelHeight] as? Int {
      try enforcePixels(width: width, height: height)
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw VisionOCRError.invalidImage }
    try enforcePixels(width: image.width, height: image.height)
    return [image]
  }

  private func rasterizePDF(data: Data) throws -> [CGImage] {
    guard let document = PDFDocument(data: data) else { throw VisionOCRError.invalidPdf }
    guard document.pageCount > 0 else { throw VisionOCRError.invalidPdf }
    guard document.pageCount <= Self.maxPages else { throw VisionOCRError.tooManyPages }
    var images: [CGImage] = []
    for index in 0..<document.pageCount {
      guard let page = document.page(at: index) else { throw VisionOCRError.invalidPdf }
      let box = page.bounds(for: .mediaBox)
      let width = max(1, Int((box.width * dpi / 72).rounded(.up)))
      let height = max(1, Int((box.height * dpi / 72).rounded(.up)))
      try enforcePixels(width: width, height: height)
      guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB), let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let image = context.makeImage() else { throw VisionOCRError.invalidPdf }
      context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      context.saveGState(); context.translateBy(x: 0, y: CGFloat(height)); context.scaleBy(x: dpi / 72, y: -dpi / 72); page.draw(with: .mediaBox, to: context); context.restoreGState()
      images.append(image)
    }
    return images
  }

  private func enforcePixels(width: Int, height: Int) throws {
    guard width > 0, height > 0, width <= Self.maxPixels / max(height, 1) else { throw VisionOCRError.tooManyPixels }
  }
}
