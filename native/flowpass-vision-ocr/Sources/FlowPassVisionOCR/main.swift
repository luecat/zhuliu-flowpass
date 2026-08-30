import Foundation
import FlowPassVisionOCRCore

// The helper accepts only bytes on stdin and emits one JSON result on stdout.
// It never accepts a user-controlled path or opens a network connection. Read
// in bounded chunks so a malformed/chunked caller cannot force unbounded memory
// growth before the core's image/PDF limits are applied.
let maxInputBytes = 12 * 1024 * 1024
var data = Data()
while true {
  do {
    guard let chunk = try FileHandle.standardInput.read(upToCount: min(64 * 1024, maxInputBytes - data.count + 1)), !chunk.isEmpty else { break }
    data.append(chunk)
    if data.count > maxInputBytes { exit(65) }
  } catch {
    exit(74)
  }
}
guard !data.isEmpty else { exit(64) }
do {
  let result = try VisionOCRProcessor().recognize(data: data)
  FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
  FileHandle.standardError.write(Data("OCR failed\n".utf8))
  exit(70)
}
