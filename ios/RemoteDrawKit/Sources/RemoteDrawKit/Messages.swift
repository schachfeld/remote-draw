import Foundation

public enum Theme: String, Codable, Sendable { case light, dark }

/// A rectangle in sheet coordinates (points, origin top-left).
public struct SheetRect: Equatable, Sendable {
    public var x, y, width, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

/// A PNG and where it sits on the sheet.
public struct Picture: Equatable, Sendable {
    public var rect: SheetRect
    public var png: Data
    public init(rect: SheetRect, png: Data) { self.rect = rect; self.png = png }
}

public struct Sheet: Equatable, Sendable {
    public static let size: Double = 4000

    public var id: String
    public var theme: Theme
    /// `#rrggbb`
    public var backgroundColor: String
    public var reference: Picture?
    /// `PKDrawing.dataRepresentation()` the desktop stored for this sheet.
    public var drawing: Data?

    public init(id: String, theme: Theme, backgroundColor: String, reference: Picture? = nil, drawing: Data? = nil) {
        self.id = id; self.theme = theme; self.backgroundColor = backgroundColor
        self.reference = reference; self.drawing = drawing
    }
}

public enum ServerMessage: Equatable {
    case hello(version: Int, serverId: String, nonce: String)
    case paired(proof: String)
    case ready(proof: String)
    /// `nil` when no pad is open on the desktop.
    case pad(Sheet?)
    case clear(sheet: String)
    case error(code: String, message: String)
    /// A type this version does not know. Ignored, so the server can grow.
    case unknown(type: String)

    public struct Invalid: Error, Equatable { public var reason: String }

    public init(json text: String) throws {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = object["type"] as? String
        else { throw Invalid(reason: "not a message object") }
        func string(_ key: String, in source: [String: Any] = object) throws -> String {
            guard let value = source[key] as? String else { throw Invalid(reason: "\(type) has no \(key)") }
            return value
        }
        switch type {
        case "hello":
            guard let version = (object["v"] as? NSNumber)?.intValue else { throw Invalid(reason: "hello has no v") }
            self = .hello(version: version, serverId: try string("serverId"), nonce: try string("nonce"))
        case "paired": self = .paired(proof: try string("proof"))
        case "ready": self = .ready(proof: try string("proof"))
        case "clear": self = .clear(sheet: try string("sheet"))
        case "error": self = .error(code: try string("code"), message: (object["message"] as? String) ?? "")
        case "pad":
            guard let open = object["open"] as? Bool else { throw Invalid(reason: "pad has no open") }
            guard open else { self = .pad(nil); return }
            guard let sheet = object["sheet"] as? [String: Any] else { throw Invalid(reason: "pad has no sheet") }
            guard let theme = Theme(rawValue: try string("theme", in: sheet)) else { throw Invalid(reason: "pad has an unknown theme") }
            var reference: Picture?
            if let value = sheet["reference"] as? [String: Any] { reference = try Self.picture(value) }
            var drawing: Data?
            if let value = sheet["drawing"] as? String { drawing = Data(base64Encoded: value, options: .ignoreUnknownCharacters) }
            self = .pad(Sheet(id: try string("id", in: sheet), theme: theme, backgroundColor: try string("backgroundColor", in: sheet),
                              reference: reference, drawing: drawing))
        default: self = .unknown(type: type)
        }
    }

    private static func picture(_ value: [String: Any]) throws -> Picture {
        func number(_ key: String) throws -> Double {
            guard let number = (value[key] as? NSNumber)?.doubleValue, number.isFinite else { throw Invalid(reason: "picture has no \(key)") }
            return number
        }
        guard let text = value["png"] as? String, let png = Data(base64Encoded: text, options: .ignoreUnknownCharacters), !png.isEmpty
        else { throw Invalid(reason: "picture has no png") }
        let rect = SheetRect(x: try number("x"), y: try number("y"), width: try number("width"), height: try number("height"))
        guard rect.width > 0, rect.height > 0 else { throw Invalid(reason: "picture has no size") }
        return Picture(rect: rect, png: png)
    }
}

/// One step of the stroke being drawn right now.
public struct Preview: Equatable {
    public static let maxPoints = 512

    public var sheet: String
    public var stroke: Int
    /// `#rrggbb`
    public var color: String
    public var width: Double
    public var points: [(x: Double, y: Double)]
    public var end: Bool
    public var cancelled: Bool

    public init(sheet: String, stroke: Int, color: String, width: Double, points: [(x: Double, y: Double)], end: Bool, cancelled: Bool = false) {
        self.sheet = sheet; self.stroke = stroke; self.color = color; self.width = width
        self.points = points; self.end = end; self.cancelled = cancelled
    }

    public static func == (a: Preview, b: Preview) -> Bool {
        a.sheet == b.sheet && a.stroke == b.stroke && a.color == b.color && a.width == b.width && a.end == b.end
            && a.cancelled == b.cancelled && a.points.count == b.points.count
            && zip(a.points, b.points).allSatisfy { $0.x == $1.x && $0.y == $1.y }
    }
}

/// The whole drawing after a change.
public struct Ink: Equatable {
    public var sheet: String
    public var through: Int
    public var theme: Theme
    public var drawing: Data
    /// Left out when the drawing is empty.
    public var image: Picture?

    public init(sheet: String, through: Int, theme: Theme, drawing: Data, image: Picture?) {
        self.sheet = sheet; self.through = through; self.theme = theme; self.drawing = drawing; self.image = image
    }
}

public enum ClientMessage: Equatable {
    case pair(deviceId: String, deviceName: String, nonce: String, proof: String)
    case auth(deviceId: String, nonce: String, proof: String)
    case preview(Preview)
    case ink(Ink)

    public var json: String {
        // Hundredths of a point are far below what the preview line can show.
        func rounded(_ value: Double) -> Double { (value * 100).rounded() / 100 }
        let object: [String: Any]
        switch self {
        case .pair(let deviceId, let deviceName, let nonce, let proof):
            object = ["type": "pair", "deviceId": deviceId, "deviceName": deviceName, "nonce": nonce, "proof": proof]
        case .auth(let deviceId, let nonce, let proof):
            object = ["type": "auth", "deviceId": deviceId, "nonce": nonce, "proof": proof]
        case .preview(let preview):
            object = ["type": "preview", "sheet": preview.sheet, "stroke": preview.stroke, "color": preview.color,
                      "width": rounded(preview.width), "points": preview.points.map { [rounded($0.x), rounded($0.y)] },
                      "end": preview.end, "cancelled": preview.cancelled]
        case .ink(let ink):
            var body: [String: Any] = ["type": "ink", "sheet": ink.sheet, "through": ink.through, "theme": ink.theme.rawValue,
                                       "drawing": ink.drawing.base64EncodedString()]
            if let image = ink.image {
                body["image"] = ["x": image.rect.x, "y": image.rect.y, "width": image.rect.width, "height": image.rect.height,
                                 "png": image.png.base64EncodedString()]
            }
            object = body
        }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
