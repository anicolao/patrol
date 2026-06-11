import AppKit
import Foundation
import Vision

struct FeatureprintResult: Encodable {
  let cropPath: String
  let width: Int
  let height: Int
  let cropBox: CropBox
  let model: String
  let dimensions: Int
  let vector: [Float]
}

struct CropBox: Encodable {
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat
}

enum FeatureprintError: Error, CustomStringConvertible {
  case usage
  case imageLoad(String)
  case humanNotFound
  case personMaskNotFound
  case cropFailed
  case writeFailed(String)
  case visionFailed
  case unsupportedElementType(String)

  var description: String {
    switch self {
    case .usage:
      return "usage: person-featureprint <input-image> <crop-output> auto [previous-image] | <input-image> <crop-output> <x> <y> <width> <height>"
    case .imageLoad(let path):
      return "failed to load image \(path)"
    case .humanNotFound:
      return "Vision did not find a human rectangle"
    case .personMaskNotFound:
      return "Vision did not find a person segmentation mask"
    case .cropFailed:
      return "failed to crop image"
    case .writeFailed(let path):
      return "failed to write crop \(path)"
    case .visionFailed:
      return "Vision did not return a feature print"
    case .unsupportedElementType(let type):
      return "unsupported Vision feature element type \(type)"
    }
  }
}

do {
  guard CommandLine.arguments.count == 4 || CommandLine.arguments.count == 5 || CommandLine.arguments.count == 7 else {
    throw FeatureprintError.usage
  }

  let inputPath = CommandLine.arguments[1]
  let cropPath = CommandLine.arguments[2]

  guard
    let image = NSImage(contentsOfFile: inputPath),
    let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else {
    throw FeatureprintError.imageLoad(inputPath)
  }

  let imageWidth = CGFloat(cgImage.width)
  let imageHeight = CGFloat(cgImage.height)
  let cropBox = try cropBoxFromArguments(cgImage: cgImage)
  let cropRect = CGRect(
    x: cropBox.x * imageWidth,
    y: cropBox.y * imageHeight,
    width: cropBox.width * imageWidth,
    height: cropBox.height * imageHeight
  ).intersection(CGRect(x: 0, y: 0, width: imageWidth, height: imageHeight))

  guard let cropImage = cgImage.cropping(to: cropRect) else {
    throw FeatureprintError.cropFailed
  }
  if CommandLine.arguments.count == 5 {
    try validatePersonCrop(cropImage)
  }

  let bitmap = NSBitmapImageRep(cgImage: cropImage)
  guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else {
    throw FeatureprintError.writeFailed(cropPath)
  }
  try jpeg.write(to: URL(fileURLWithPath: cropPath), options: [.atomic])

  let request = VNGenerateImageFeaturePrintRequest()
  let handler = VNImageRequestHandler(cgImage: cropImage, options: [:])
  try handler.perform([request])

  guard let observation = request.results?.first as? VNFeaturePrintObservation else {
    throw FeatureprintError.visionFailed
  }

  let vector = try floats(from: observation)
  let result = FeatureprintResult(
    cropPath: cropPath,
    width: cropImage.width,
    height: cropImage.height,
    cropBox: cropBox,
    model: "apple-vision-featureprint",
    dimensions: vector.count,
    vector: vector
  )
  let encoded = try JSONEncoder().encode(result)
  FileHandle.standardOutput.write(encoded)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}

func normalized(_ rawValue: String) -> CGFloat {
  guard let value = Double(rawValue), value.isFinite else {
    return 0
  }
  return CGFloat(max(0, min(1, value)))
}

func cropBoxFromArguments(cgImage: CGImage) throws -> CropBox {
  if CommandLine.arguments.count == 4 {
    guard CommandLine.arguments[3] == "auto" else {
      throw FeatureprintError.usage
    }
    return try detectedHumanCropBox(cgImage: cgImage)
  }

  if CommandLine.arguments.count == 5 {
    guard CommandLine.arguments[3] == "auto" else {
      throw FeatureprintError.usage
    }
    let previousPath = CommandLine.arguments[4]
    guard
      let previousImage = NSImage(contentsOfFile: previousPath),
      let previousCgImage = previousImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
      throw FeatureprintError.imageLoad(previousPath)
    }
    return try motionCropBox(current: cgImage, previous: previousCgImage)
  }

  return expandedCropBox(
    CropBox(
      x: normalized(CommandLine.arguments[3]),
      y: normalized(CommandLine.arguments[4]),
      width: normalized(CommandLine.arguments[5]),
      height: normalized(CommandLine.arguments[6])
    ),
    margin: 0
  )
}

func detectedHumanCropBox(cgImage: CGImage) throws -> CropBox {
  return try detectedPersonSegmentationCropBox(cgImage: cgImage)
}

func motionCropBox(current: CGImage, previous: CGImage) throws -> CropBox {
  let targetWidth = min(960, current.width)
  let targetHeight = max(1, Int(round(Double(targetWidth) * Double(current.height) / Double(current.width))))
  let currentPixels = try renderedPixels(current, width: targetWidth, height: targetHeight)
  let previousPixels = try renderedPixels(previous, width: targetWidth, height: targetHeight)
  let mask = motionMask(current: currentPixels, previous: previousPixels)
  let components = connectedComponents(mask: mask, width: targetWidth, height: targetHeight)
  guard let component = components.max(by: { motionComponentScore($0) < motionComponentScore($1) }) else {
    return try detectedHumanCropBox(cgImage: current)
  }

  let box = CropBox(
    x: CGFloat(component.minX) / CGFloat(targetWidth),
    y: CGFloat(component.minY) / CGFloat(targetHeight),
    width: CGFloat(component.maxX - component.minX + 1) / CGFloat(targetWidth),
    height: CGFloat(component.maxY - component.minY + 1) / CGFloat(targetHeight)
  )
  return try expandedMotionCropBox(box)
}

func detectedPersonSegmentationCropBox(cgImage: CGImage) throws -> CropBox {
  let request = VNGeneratePersonSegmentationRequest()
  request.qualityLevel = .balanced
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])

  guard let observation = request.results?.first else {
    throw FeatureprintError.personMaskNotFound
  }

  return try expandedReviewCropBox(maskCropBox(observation.pixelBuffer))
}

func detectedHumanRectangleCropBox(cgImage: CGImage) throws -> CropBox {
  let request = VNDetectHumanRectanglesRequest()
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])

  guard let observation = request.results?.max(by: { area($0.boundingBox) < area($1.boundingBox) }) else {
    throw FeatureprintError.humanNotFound
  }

  let boundingBox = observation.boundingBox
  return expandedReviewCropBox(
    CropBox(
      x: boundingBox.minX,
      y: 1 - boundingBox.maxY,
      width: boundingBox.width,
      height: boundingBox.height
    )
  )
}

func validatePersonCrop(_ cropImage: CGImage) throws {
  _ = try detectedPersonSegmentationCropBox(cgImage: cropImage)
}

func maskCropBox(_ pixelBuffer: CVPixelBuffer) throws -> CropBox {
  CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
  defer {
    CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
  }

  let width = CVPixelBufferGetWidth(pixelBuffer)
  let height = CVPixelBufferGetHeight(pixelBuffer)
  let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
  guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
    throw FeatureprintError.personMaskNotFound
  }

  let bytes = baseAddress.assumingMemoryBound(to: UInt8.self)
  var minX = width
  var minY = height
  var maxX = 0
  var maxY = 0
  var count = 0

  for y in 0..<height {
    let row = bytes.advanced(by: y * bytesPerRow)
    for x in 0..<width {
      if row[x] > 32 {
        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x)
        maxY = max(maxY, y)
        count += 1
      }
    }
  }

  if count < 64 || minX > maxX || minY > maxY {
    throw FeatureprintError.personMaskNotFound
  }

  return CropBox(
    x: CGFloat(minX) / CGFloat(width),
    y: CGFloat(minY) / CGFloat(height),
    width: CGFloat(maxX - minX + 1) / CGFloat(width),
    height: CGFloat(maxY - minY + 1) / CGFloat(height)
  )
}

func expandedCropBox(_ box: CropBox, margin: CGFloat) -> CropBox {
  let x = max(0, box.x - box.width * margin)
  let y = max(0, box.y - box.height * margin)
  let right = min(1, box.x + box.width * (1 + margin))
  let bottom = min(1, box.y + box.height * (1 + margin))
  return CropBox(
    x: rounded(x),
    y: rounded(y),
    width: rounded(max(0.01, right - x)),
    height: rounded(max(0.01, bottom - y))
  )
}

func expandedReviewCropBox(_ box: CropBox) -> CropBox {
  let x = box.x - box.width * 0.55
  let y = box.y - box.height * 0.65
  let right = box.x + box.width * 1.55
  let bottom = box.y + box.height * 1.3
  return cropBoxWithMinimumSize(
    CropBox(
      x: x,
      y: y,
      width: right - x,
      height: bottom - y
    ),
    minWidth: 0.08,
    minHeight: 0.18
  )
}

func expandedMotionCropBox(_ box: CropBox) throws -> CropBox {
  let x = box.x - box.width * 0.35
  let y = box.y - box.height * 0.45
  let right = box.x + box.width * 1.35
  let bottom = box.y + box.height * 1.25
  let expanded = cropBoxWithMinimumSize(
    CropBox(
      x: x,
      y: y,
      width: right - x,
      height: bottom - y
    ),
    minWidth: 0.08,
    minHeight: 0.18
  )
  if expanded.x <= 0.001 ||
    expanded.y <= 0.001 ||
    expanded.x + expanded.width >= 0.999 ||
    expanded.y + expanded.height >= 0.999
  {
    throw FeatureprintError.humanNotFound
  }
  return expanded
}

func cropBoxWithMinimumSize(_ box: CropBox, minWidth: CGFloat, minHeight: CGFloat) -> CropBox {
  let width = max(box.width, minWidth)
  let height = max(box.height, minHeight)
  let centerX = box.x + box.width / 2
  let centerY = box.y + box.height / 2
  let x = min(max(0, centerX - width / 2), max(0, 1 - width))
  let y = min(max(0, centerY - height / 2), max(0, 1 - height))
  return CropBox(
    x: rounded(x),
    y: rounded(y),
    width: rounded(min(width, 1)),
    height: rounded(min(height, 1))
  )
}

struct PixelBuffer {
  let width: Int
  let height: Int
  let bytes: [UInt8]
}

struct MotionComponent {
  var minX: Int
  var minY: Int
  var maxX: Int
  var maxY: Int
  var count: Int
}

func renderedPixels(_ image: CGImage, width: Int, height: Int) throws -> PixelBuffer {
  var bytes = [UInt8](repeating: 0, count: width * height * 4)
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let ok = bytes.withUnsafeMutableBytes { rawBuffer in
    guard let baseAddress = rawBuffer.baseAddress else {
      return false
    }
    guard
      let context = CGContext(
        data: baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else {
      return false
    }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  if !ok {
    throw FeatureprintError.cropFailed
  }
  return PixelBuffer(width: width, height: height, bytes: bytes)
}

func motionMask(current: PixelBuffer, previous: PixelBuffer) -> [Bool] {
  var mask = [Bool](repeating: false, count: current.width * current.height)
  for y in 0..<current.height {
    for x in 0..<current.width {
      if shouldIgnoreMotionPixel(x: x, y: y, width: current.width, height: current.height) {
        continue
      }
      let offset = (y * current.width + x) * 4
      let red = abs(Int(current.bytes[offset]) - Int(previous.bytes[offset]))
      let green = abs(Int(current.bytes[offset + 1]) - Int(previous.bytes[offset + 1]))
      let blue = abs(Int(current.bytes[offset + 2]) - Int(previous.bytes[offset + 2]))
      mask[y * current.width + x] = red + green + blue > 72
    }
  }
  return mask
}

func shouldIgnoreMotionPixel(x: Int, y: Int, width: Int, height: Int) -> Bool {
  let nx = CGFloat(x) / CGFloat(width)
  let ny = CGFloat(y) / CGFloat(height)
  if nx > 0.72 && ny < 0.12 {
    return true
  }
  if nx > 0.82 && ny > 0.86 {
    return true
  }
  return false
}

func connectedComponents(mask: [Bool], width: Int, height: Int) -> [MotionComponent] {
  var visited = [Bool](repeating: false, count: mask.count)
  var components: [MotionComponent] = []
  let neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]

  for index in 0..<mask.count {
    if visited[index] || !mask[index] {
      continue
    }

    var stack = [index]
    visited[index] = true
    var component = MotionComponent(
      minX: index % width,
      minY: index / width,
      maxX: index % width,
      maxY: index / width,
      count: 0
    )

    while let currentIndex = stack.popLast() {
      let x = currentIndex % width
      let y = currentIndex / width
      component.minX = min(component.minX, x)
      component.minY = min(component.minY, y)
      component.maxX = max(component.maxX, x)
      component.maxY = max(component.maxY, y)
      component.count += 1

      for (dx, dy) in neighbors {
        let nx = x + dx
        let ny = y + dy
        if nx < 0 || nx >= width || ny < 0 || ny >= height {
          continue
        }
        let nextIndex = ny * width + nx
        if visited[nextIndex] || !mask[nextIndex] {
          continue
        }
        visited[nextIndex] = true
        stack.append(nextIndex)
      }
    }

    if isPlausibleMotionComponent(component, width: width, height: height) {
      components.append(component)
    }
  }

  return components
}

func isPlausibleMotionComponent(_ component: MotionComponent, width: Int, height: Int) -> Bool {
  let boxWidth = CGFloat(component.maxX - component.minX + 1) / CGFloat(width)
  let boxHeight = CGFloat(component.maxY - component.minY + 1) / CGFloat(height)
  if component.count < 32 {
    return false
  }
  if component.minX <= 1 || component.minY <= 1 || component.maxX >= width - 2 || component.maxY >= height - 2 {
    return false
  }
  if boxWidth < 0.006 || boxHeight < 0.018 {
    return false
  }
  if boxWidth > 0.25 || boxHeight > 0.35 {
    return false
  }
  return true
}

func motionComponentScore(_ component: MotionComponent) -> CGFloat {
  let width = CGFloat(component.maxX - component.minX + 1)
  let height = CGFloat(component.maxY - component.minY + 1)
  return CGFloat(component.count) + height * 3 + min(width, height) * 2
}

func area(_ rect: CGRect) -> CGFloat {
  return rect.width * rect.height
}

func rounded(_ value: CGFloat) -> CGFloat {
  return (value * 10000).rounded() / 10000
}

func floats(from observation: VNFeaturePrintObservation) throws -> [Float] {
  let data = observation.data
  switch observation.elementType {
  case .float:
    return data.withUnsafeBytes { bytes in
      Array(bytes.bindMemory(to: Float.self))
    }
  case .double:
    return data.withUnsafeBytes { bytes in
      Array(bytes.bindMemory(to: Double.self).map(Float.init))
    }
  default:
    throw FeatureprintError.unsupportedElementType(String(describing: observation.elementType))
  }
}
