import RemoteDrawKit
import SwiftUI

/// The sheet, covered by a notice whenever the iPad cannot draw into a pad.
struct PadScreen: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmsForget = false
    @Environment(\.colorScheme) private var systemScheme

    var body: some View {
        ZStack {
            CanvasHost(controller: model.canvas).ignoresSafeArea()
            if let notice { NoticeView(notice: notice).transition(.opacity) }
        }
        .animation(.default, value: notice)
        .overlay(alignment: .topLeading) { connectionMenu.padding(12) }
        // The label sits on the sheet, which has the desktop's theme, not the iPad's.
        .environment(\.colorScheme, (model.sheetIsDark ?? (systemScheme == .dark)) ? .dark : .light)
        .confirmationDialog("Forget \(macName)?", isPresented: $confirmsForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { model.forgetPairing() }
        } message: {
            Text("This iPad will need to scan a new QR code to draw again. Remove it in the Remote Draw settings on the desktop as well.")
        }
    }

    private var macName: String { model.pairing?.name ?? "the Mac" }

    private var connectionMenu: some View {
        Menu {
            Button("Pair with Another Mac…", systemImage: "qrcode.viewfinder") { model.showsPairing = true }
            Button("Forget \(macName)", systemImage: "trash", role: .destructive) { confirmsForget = true }
        } label: {
            HStack(spacing: 8) {
                Circle().fill(model.link == .connected ? Color.green : Color.orange).frame(width: 8, height: 8)
                Text(macName).font(.subheadline.weight(.medium)).lineLimit(1)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
        }
        .tint(.primary)
        .accessibilityLabel(model.link == .connected ? "Connected to \(macName)" : "Not connected to \(macName)")
    }

    private var notice: Notice? {
        switch model.link {
        case .connected:
            return model.padOpen ? nil : Notice(symbol: "rectangle.and.pencil.and.ellipsis", title: "Open Remote Draw on the desktop",
                                                detail: "In a LearnHarness session on \(macName), press Remote draw. The question appears here and you can draw.")
        case .idle, .connecting, .waiting(.unreachable):
            return Notice(symbol: "wifi", title: "Looking for \(macName)…",
                          detail: "LearnHarness has to be running with Remote Draw enabled, and both devices on the same network or tailnet.", busy: true)
        case .waiting(.busy):
            return Notice(symbol: "ipad.landscape", title: "Another iPad is connected",
                          detail: "\(macName) draws with one iPad at a time. This one connects as soon as the other disconnects.", busy: true)
        case .stopped(.replaced):
            return Notice(symbol: "arrow.triangle.2.circlepath", title: "Connected somewhere else",
                          detail: "This iPad's pairing is being used by another connection.", action: "Reconnect")
        case .stopped(.unsupportedVersion):
            return Notice(symbol: "arrow.down.circle", title: "Update needed",
                          detail: "The Remote Draw plugin on \(macName) uses a newer protocol. Update this app.")
        case .stopped:
            return nil // Pairing problems switch to the pairing screen.
        }
    }
}

struct Notice: Equatable {
    var symbol: String
    var title: String
    var detail: String
    var busy = false
    var action: String?
}

private struct NoticeView: View {
    @EnvironmentObject private var model: AppModel
    let notice: Notice

    var body: some View {
        ZStack {
            Rectangle().fill(.regularMaterial).ignoresSafeArea()
            VStack(spacing: 14) {
                Image(systemName: notice.symbol).font(.system(size: 44, weight: .light)).foregroundStyle(.secondary)
                Text(notice.title).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                Text(notice.detail).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if notice.busy { ProgressView().padding(.top, 4) }
                if let action = notice.action {
                    Button(action) { model.reconnect() }.buttonStyle(.borderedProminent).padding(.top, 4)
                }
            }
            .frame(maxWidth: 420)
            .padding(32)
        }
    }
}

private struct CanvasHost: UIViewControllerRepresentable {
    let controller: CanvasViewController
    func makeUIViewController(context: Context) -> CanvasViewController { controller }
    func updateUIViewController(_ controller: CanvasViewController, context: Context) {}
}
