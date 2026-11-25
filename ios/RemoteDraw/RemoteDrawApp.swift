import SwiftUI

@main
struct RemoteDrawApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if model.pairing == nil || model.showsPairing { PairingScreen() } else { PadScreen() }
            }
            .environmentObject(model)
            // Scanning the QR code with the Camera app opens the pairing link here.
            .onOpenURL { model.pair(uri: $0.absoluteString) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.becameActive() }
            }
        }
    }
}
