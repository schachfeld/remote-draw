import PencilKit
import RemoteDrawKit
import UIKit

/// Turns the PencilKit drawing into the picture the desktop shows and sends.
enum InkRenderer {
    static let pixelsPerPoint: CGFloat = 2
    static let longestSide: CGFloat = 4096
    /// The frame limit is 24 MiB and base64 adds a third; this leaves room for the drawing data.
    static let largestPNG = 12 * 1024 * 1024

    /// A transparent PNG of the ink alone, covering the drawing's bounds.
    /// `nil` for an empty drawing. Safe to call off the main thread.
    static func render(_ drawing: PKDrawing, theme: Theme) -> Picture? {
        let bounds = drawing.bounds
        guard !drawing.strokes.isEmpty, !bounds.isNull, !bounds.isInfinite, bounds.width > 0, bounds.height > 0 else { return nil }
        let rect = bounds.integral
        var scale = min(pixelsPerPoint, longestSide / max(rect.width, rect.height))
        // PencilKit swaps black and white ink by the current appearance; it has to be the desktop's.
        let traits = UITraitCollection(userInterfaceStyle: theme == .dark ? .dark : .light)
        for _ in 0..<4 {
            var image: UIImage?
            traits.performAsCurrent { image = drawing.image(from: rect, scale: scale) }
            guard let png = image?.pngData() else { return nil }
            if png.count <= largestPNG {
                return Picture(rect: SheetRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height), png: png)
            }
            scale /= 2
        }
        return nil
    }
}

extension UIColor {
    convenience init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    /// `#rrggbb` in sRGB as this colour looks in the given appearance.
    func hex(in style: UIUserInterfaceStyle) -> String {
        let resolved = resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).cgColor
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let parts = resolved.converted(to: space, intent: .defaultIntent, options: nil)?.components ?? [0, 0, 0, 1]
        let rgb = parts.count >= 3 ? Array(parts.prefix(3)) : [parts[0], parts[0], parts[0]]
        return "#" + rgb.map { String(format: "%02x", Int((min(max($0, 0), 1) * 255).rounded())) }.joined()
    }
}
