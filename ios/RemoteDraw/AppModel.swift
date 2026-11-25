import RemoteDrawKit
import SwiftUI
import UIKit

/// What the app knows: whether it is paired, how the connection is doing and
/// whether a pad is open on the desktop.
@MainActor
final class AppModel: ObservableObject {
    enum PairingPhase: Equatable {
        case idle
        /// Talking to the named Mac.
        case working(String)
        case failed(String)
    }

    @Published private(set) var pairing: Pairing?
    @Published private(set) var link: LinkClient.State = .idle
    @Published private(set) var padOpen = false
    /// The theme of the sheet on screen; `nil` before the first one.
    @Published private(set) var sheetIsDark: Bool?
    @Published private(set) var pairingPhase: PairingPhase = .idle
    /// The pairing screen was asked for although a Mac is already paired.
    @Published var showsPairing = false

    let canvas = CanvasViewController()
    private let client = LinkClient(device: PairingStore.device)

    init() {
        pairing = PairingStore.load()
        canvas.send = { [client] in client.send($0) }
        client.log = { print("[link]", $0) }
        client.onPad = { [weak self] sheet in
            self?.canvas.show(pad: sheet)
            self?.padOpen = sheet != nil
            if let sheet { self?.sheetIsDark = sheet.theme == .dark }
            self?.updateIdleTimer()
        }
        client.onClear = { [weak self] in self?.canvas.clear(sheet: $0) }
        client.onPairing = { [weak self] pairing in
            guard let self else { return }
            PairingStore.save(pairing)
            self.pairing = pairing
            self.pairingPhase = .idle
            self.showsPairing = false
        }
        client.onState = { [weak self] in self?.linkChanged($0) }
        if let pairing { client.connect(pairing: pairing) }
    }

    private func linkChanged(_ state: LinkClient.State) {
        link = state
        if state != .connected { padOpen = false }
        canvas.setConnected(state == .connected)
        updateIdleTimer()
        switch state {
        case .stopped(.pairingFailed(let message)):
            pairingPhase = .failed(message)
            resume()
        case .stopped(.unauthorized(let message)):
            forget(showing: message)
        case .stopped(.forgotten):
            forget(showing: "This iPad was removed in the Remote Draw settings on the desktop. Pair it again to draw.")
        default: break
        }
    }

    /// The text of a scanned QR code, a pasted pairing link or an opened URL.
    func pair(uri: String) {
        if case .working = pairingPhase { return } // The camera reports the same code many times.
        do {
            let invite = try PairingInvite(uri: uri)
            pairingPhase = .working(invite.name)
            client.pair(invite: invite)
        } catch {
            pairingPhase = .failed(error.localizedDescription)
        }
    }

    /// Other QR codes in view are not worth an error message.
    func scanned(_ text: String) {
        if text.lowercased().hasPrefix(PairingInvite.scheme + "://") { pair(uri: text) }
    }

    func cancelPairing() {
        pairingPhase = .idle
        showsPairing = false
        client.disconnect()
        resume()
    }

    /// Only this iPad forgets; the desktop still lists it until it is removed there.
    func forgetPairing() {
        client.disconnect()
        forget(showing: nil)
    }

    func becameActive() {
        client.retryNow()
    }

    func reconnect() {
        client.retryNow()
    }

    private func resume() {
        if let pairing { client.connect(pairing: pairing) }
    }

    private func forget(showing message: String?) {
        PairingStore.clear()
        pairing = nil
        pairingPhase = message.map { .failed($0) } ?? .idle
    }

    /// Writing with pauses must not let the screen sleep.
    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = padOpen && link == .connected
    }
}
