// Reads image or PDF bytes from stdin, writes one JSON object to stdout.
// Bytes never touch the filesystem: decrypted vault documents must not land in
// a temp file just to be recognized.
//
// Usage: flowpass-ocr <media-type> [comma,separated,languages]
import Foundation
import Vision
import AppKit
import PDFKit

struct Line: Encodable {
    let text: String
    let confidence: Double
    let box: Box
    struct Box: Encodable { let x, y, width, height: Double }
}

func fail(_ code: String, _ detail: String = "") -> Never {
    FileHandle.standardError.write("\(code) \(detail)\n".data(using: .utf8)!)
    exit(code == "OCR_MEDIA_UNSUPPORTED" ? 3 : 1)
}

let arguments = CommandLine.arguments
guard arguments.count > 1 else { fail("OCR_FAILED", "usage: flowpass-ocr <media-type> [languages]") }
let mediaType = arguments[1]
let languages = arguments.count > 2 && !arguments[2].isEmpty
    ? arguments[2].split(separator: ",").map(String.init)
    : ["zh-Hant", "en-US"]

let data = FileHandle.standardInput.readDataToEndOfFile()
guard !data.isEmpty else { fail("OCR_FAILED", "empty input") }

func images(from data: Data, mediaType: String) -> [CGImage] {
    if mediaType == "application/pdf" {
        guard let document = PDFDocument(data: data) else { return [] }
        var pages: [CGImage] = []
        // Cap the page count: a receipt is one or two pages, and an unbounded
        // loop here would let a large upload occupy the worker.
        for index in 0..<min(document.pageCount, 5) {
            guard let page = document.page(at: index) else { continue }
            let bounds = page.bounds(for: .mediaBox)
            let scale: CGFloat = 2  // small print needs the extra resolution
            let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
            guard width > 0, height > 0, width * height < 40_000_000,
                  let context = CGContext(data: nil, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
            else { continue }
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.scaleBy(x: scale, y: scale)
            page.draw(with: .mediaBox, to: context)
            if let image = context.makeImage() { pages.append(image) }
        }
        return pages
    }
    guard let representation = NSBitmapImageRep(data: data), let image = representation.cgImage else { return [] }
    return [image]
}

let pages = images(from: data, mediaType: mediaType)
guard !pages.isEmpty else { fail("OCR_MEDIA_UNSUPPORTED", mediaType) }

var lines: [Line] = []
for page in pages {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true
    do {
        try VNImageRequestHandler(cgImage: page, options: [:]).perform([request])
    } catch {
        fail("OCR_FAILED", "\(error)")
    }
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        lines.append(Line(
            text: candidate.string,
            confidence: Double(candidate.confidence),
            box: .init(x: Double(box.origin.x), y: Double(box.origin.y),
                       width: Double(box.size.width), height: Double(box.size.height))
        ))
    }
}

do {
    FileHandle.standardOutput.write(try JSONEncoder().encode(["lines": lines]))
} catch {
    fail("OCR_FAILED", "encode failed")
}
