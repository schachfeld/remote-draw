import PencilKit
import RemoteDrawKit
import UIKit

/// The sheet: a PencilKit canvas over the question picture. Applies what the
/// desktop says (`pad`, `clear`) and reports what the Pencil does (`preview`, `ink`).
final class CanvasViewController: UIViewController, PKCanvasViewDelegate {
    /// Returns false when the message could not go out.
    var send: (ClientMessage) -> Bool = { _ in false }

    private let canvas = PKCanvasView()
    private let toolPicker = PKToolPicker()
    private let referenceView = UIImageView()
    private let strokes = StrokeObserver()
    private let renderQueue = DispatchQueue(label: "remote-draw.ink", qos: .userInitiated)

    /// The loaded sheet. Kept while the pad is closed or the link is down, so
    /// the same sheet coming back loses nothing.
    private var sheet: Sheet?
    private var padOpen = false
    private var connected = false
    private var accepting: Bool { padOpen && connected }
    /// The desktop may have missed the last picture when the link dropped.
    private var resendOnNextPad = false
    private var needsStartPosition = true
    /// A drawing put on the canvas by code. PencilKit reports it like a change by hand, a moment later.
    private var drawingSetByCode: PKDrawing?

    // The stroke in progress, for `preview`.
    private var strokeNumber = 0
    private var current: (number: Int, color: String, width: Double)?
    private var buffered: [(x: Double, y: Double)] = []
    private var flushTimer: Timer?
    /// Finished strokes PencilKit has not put into the drawing yet.
    private var ended: [(number: Int, at: Date)] = []
    private var through = 0
    private var strokeCount = 0

    // `ink`: one render at a time, always of the newest drawing.
    private var inkWanted = 0, inkSent = 0, rendering = false
    /// Grows when a render in progress must not be sent any more.
    private var inkEpoch = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        canvas.frame = view.bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        canvas.delegate = self
        canvas.isOpaque = false
        canvas.backgroundColor = .clear
        canvas.contentSize = CGSize(width: Sheet.size, height: Sheet.size)
        canvas.contentInsetAdjustmentBehavior = .never
        canvas.minimumZoomScale = 0.25
        canvas.maximumZoomScale = 4
        #if targetEnvironment(simulator)
        canvas.drawingPolicy = .anyInput // The simulator has no Pencil.
        #else
        canvas.drawingPolicy = .pencilOnly
        #endif
        referenceView.isUserInteractionEnabled = false
        canvas.insertSubview(referenceView, at: 0)
        view.addSubview(canvas)

        strokes.onBegan = { [weak self] in self?.strokeBegan($0) }
        strokes.onMoved = { [weak self] in self?.strokeMoved($0) }
        strokes.onEnded = { [weak self] in self?.strokeEnded(cancelled: $0) }
        #if !targetEnvironment(simulator)
        strokes.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        #endif
        canvas.addGestureRecognizer(strokes)
        toolPicker.addObserver(canvas)
        updateAccepting()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        updateAccepting()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = canvas.bounds.size
        guard size.width > 0, size.height > 0 else { return }
        // Never zoom out past the point where the sheet stops filling the screen.
        let minimum = max(size.width, size.height) / Sheet.size
        if canvas.minimumZoomScale != minimum { canvas.minimumZoomScale = minimum }
        if canvas.zoomScale < minimum { canvas.zoomScale = minimum }
        if needsStartPosition { goToStart() }
    }

    // MARK: From the desktop

    func setConnected(_ value: Bool) {
        guard value != connected else { return }
        connected = value
        if value {
            // Stroke numbers start at 1 for each connection.
            strokeNumber = 0; through = 0; ended.removeAll()
            resendOnNextPad = true
        } else {
            padOpen = false // The next connection says whether a pad is open.
            inkEpoch += 1
        }
        updateAccepting()
    }

    /// `nil` when no pad is open on the desktop.
    func show(pad next: Sheet?) {
        loadViewIfNeeded()
        guard let next else {
            padOpen = false
            return updateAccepting()
        }
        padOpen = true
        let previous = sheet
        sheet = next
        applyAppearance(of: next)
        if next.id != previous?.id {
            let stored = next.drawing.flatMap { try? PKDrawing(data: $0) }
            setDrawing(stored ?? PKDrawing())
            ended.removeAll()
            inkEpoch += 1
            goToStart()
            // The desktop's picture may have been rendered for another theme, or
            // belong to drawing data this app cannot read.
            if next.drawing != nil { scheduleInk() }
        } else if next.theme != previous?.theme || resendOnNextPad {
            scheduleInk()
        }
        resendOnNextPad = false
        updateAccepting()
        pumpInk()
    }

    func clear(sheet id: String) {
        guard id == sheet?.id else { return }
        setDrawing(PKDrawing())
        ended.removeAll()
        inkEpoch += 1
        // The answer is what makes both sides agree if a stroke was on its way.
        scheduleInk()
    }

    private func setDrawing(_ drawing: PKDrawing) {
        drawingSetByCode = drawing
        canvas.drawing = drawing
        strokeCount = drawing.strokes.count
        canvas.undoManager?.removeAllActions()
    }

    private func applyAppearance(of sheet: Sheet) {
        let style: UIUserInterfaceStyle = sheet.theme == .dark ? .dark : .light
        overrideUserInterfaceStyle = style
        toolPicker.overrideUserInterfaceStyle = style
        toolPicker.colorUserInterfaceStyle = style
        view.backgroundColor = UIColor(hex: sheet.backgroundColor) ?? .systemBackground
        referenceView.image = sheet.reference.flatMap { UIImage(data: $0.png) }
        layoutReference()
    }

    private func updateAccepting() {
        guard isViewLoaded else { return }
        canvas.isUserInteractionEnabled = accepting
        if accepting, view.window != nil {
            toolPicker.setVisible(true, forFirstResponder: canvas)
            canvas.becomeFirstResponder()
        } else {
            toolPicker.setVisible(false, forFirstResponder: canvas)
            canvas.resignFirstResponder()
            strokeEnded(cancelled: true)
        }
    }

    // MARK: View

    private func layoutReference() {
        guard let rect = sheet?.reference?.rect, referenceView.image != nil else { return referenceView.isHidden = true }
        let zoom = canvas.zoomScale
        referenceView.isHidden = false
        referenceView.frame = CGRect(x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom)
    }

    /// The question picture at the top of the screen, or the sheet centre.
    private func goToStart() {
        let size = canvas.bounds.size
        guard isViewLoaded, size.width > 0, size.height > 0 else { return needsStartPosition = true }
        needsStartPosition = false
        canvas.setZoomScale(1, animated: false)
        var target = CGPoint(x: (Sheet.size - size.width) / 2, y: (Sheet.size - size.height) / 2)
        if let rect = sheet?.reference?.rect {
            // Leave room for the status bar and the connection label.
            target = CGPoint(x: rect.x + rect.width / 2 - size.width / 2, y: rect.y - view.safeAreaInsets.top - 64)
        }
        target.x = min(max(target.x, 0), max(Sheet.size - size.width, 0))
        target.y = min(max(target.y, 0), max(Sheet.size - size.height, 0))
        canvas.setContentOffset(target, animated: false)
        layoutReference()
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        layoutReference()
    }

    // MARK: Preview of the stroke in progress

    private func sheetPoints(_ points: [CGPoint]) -> [(x: Double, y: Double)] {
        let zoom = canvas.zoomScale
        return points.map { (x: Double($0.x / zoom), y: Double($0.y / zoom)) }
    }

    private func strokeBegan(_ points: [CGPoint]) {
        // Nothing is previewed for the eraser, the lasso or the ruler.
        guard accepting, current == nil, let sheet, let tool = canvas.tool as? PKInkingTool, !canvas.isRulerActive else { return }
        let style: UIUserInterfaceStyle = sheet.theme == .dark ? .dark : .light
        strokeNumber += 1
        // Tool colours are stored as they look in light mode.
        let shown = PKInkingTool.convertColor(tool.color, from: .light, to: style)
        current = (strokeNumber, shown.hex(in: style), min(max(Double(tool.width), 0.5), 100))
        buffered = sheetPoints(points)
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.flush(end: false, cancelled: false) }
        RunLoop.main.add(timer, forMode: .common)
        flushTimer = timer
    }

    private func strokeMoved(_ points: [CGPoint]) {
        guard current != nil else { return }
        buffered.append(contentsOf: sheetPoints(points))
    }

    private func strokeEnded(cancelled: Bool) {
        guard let stroke = current else { return }
        flush(end: true, cancelled: cancelled)
        flushTimer?.invalidate(); flushTimer = nil
        current = nil
        if !cancelled { ended.append((stroke.number, Date())) }
    }

    private func flush(end: Bool, cancelled: Bool) {
        guard let stroke = current, let sheet, end || !buffered.isEmpty else { return }
        var points = buffered
        buffered = []
        repeat {
            let chunk = Array(points.prefix(Preview.maxPoints))
            points.removeFirst(chunk.count)
            let last = points.isEmpty
            _ = send(.preview(Preview(sheet: sheet.id, stroke: stroke.number, color: stroke.color, width: stroke.width,
                                      points: chunk, end: end && last, cancelled: end && last && cancelled)))
        } while !points.isEmpty
    }

    // MARK: Ink

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        if let expected = drawingSetByCode {
            drawingSetByCode = nil
            if canvasView.drawing == expected { return }
        }
        let count = canvasView.drawing.strokes.count
        let added = count - strokeCount
        strokeCount = count
        // A finished stroke reaches the drawing within moments, so one that
        // ended half a second ago has either arrived or left no ink. After
        // those, PencilKit adds strokes in the order they were drawn.
        var covered = 0
        while covered < ended.count, ended[covered].at.timeIntervalSinceNow < -0.5 { covered += 1 }
        covered = min(covered + max(added, 0), ended.count)
        if covered > 0 {
            through = max(through, ended[covered - 1].number)
            ended.removeFirst(covered)
        }
        scheduleInk()
    }

    private func scheduleInk() {
        inkWanted += 1
        pumpInk()
    }

    private func pumpInk() {
        guard !rendering, inkSent != inkWanted, accepting, let sheet else { return }
        rendering = true
        let wanted = inkWanted, epoch = inkEpoch, through = through
        let drawing = canvas.drawing, id = sheet.id, theme = sheet.theme
        renderQueue.async { [weak self] in
            let ink = Ink(sheet: id, through: through, theme: theme, drawing: drawing.dataRepresentation(),
                          image: InkRenderer.render(drawing, theme: theme))
            DispatchQueue.main.async {
                guard let self else { return }
                self.rendering = false
                // A picture from before a clear, a new sheet or a lost link is dropped;
                // an older one of the same drawing still goes out, so fast writing shows up.
                if epoch == self.inkEpoch, self.accepting, self.sheet?.id == id, self.sheet?.theme == theme, self.send(.ink(ink)) {
                    self.inkSent = wanted
                }
                self.pumpInk()
            }
        }
    }
}
