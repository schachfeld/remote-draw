import UIKit

/// Watches the touches PencilKit draws with, without taking them away, so the
/// stroke in progress can be shown on the desktop.
final class StrokeObserver: UIGestureRecognizer, UIGestureRecognizerDelegate {
    /// Points are in the coordinates of the view the recognizer is attached to.
    var onBegan: (([CGPoint]) -> Void)?
    var onMoved: (([CGPoint]) -> Void)?
    var onEnded: ((_ cancelled: Bool) -> Void)?

    private weak var tracked: UITouch?

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    private func points(_ touch: UITouch, _ event: UIEvent?) -> [CGPoint] {
        (event?.coalescedTouches(for: touch) ?? [touch]).map { $0.preciseLocation(in: view) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard tracked == nil, let touch = touches.first else { return }
        tracked = touch
        state = .began
        onBegan?(points(touch, event))
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = tracked, touches.contains(touch) else { return }
        state = .changed
        onMoved?(points(touch, event))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = tracked, touches.contains(touch) else { return }
        tracked = nil
        state = .ended
        onEnded?(false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = tracked, touches.contains(touch) else { return }
        tracked = nil
        state = .cancelled
        onEnded?(true)
    }

    override func reset() {
        super.reset()
        if tracked != nil { tracked = nil; onEnded?(true) }
    }

    // Never stands in the way of PencilKit's own recognizers or the scrolling.
    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
