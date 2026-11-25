import AVFoundation
import SwiftUI

/// First launch, or "Pair with Another Mac": scan the QR code from the plugin settings.
struct PairingScreen: View {
    @EnvironmentObject private var model: AppModel
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var typed = ""
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Text("Pair with your Mac").font(.largeTitle.weight(.bold))
                    Text("In LearnHarness, open Settings → Remote Draw and choose Pair an iPad. Then point the camera at the QR code.")
                        .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                scanner
                    .frame(maxWidth: 380).aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                status
                HStack {
                    TextField("Or paste the pairing link (remotedraw://…)", text: $typed)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .onSubmit { submitTyped() }
                    Button("Pair") { submitTyped() }
                        .buttonStyle(.bordered)
                        .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if model.pairing != nil {
                    Button("Cancel") { model.cancelPairing() }
                } else if isWorking {
                    Button("Cancel") { model.cancelPairing() }
                }
            }
            .frame(maxWidth: 520)
            .padding(32)
            .frame(maxWidth: .infinity)
        }
        .task {
            if camera == .notDetermined {
                camera = await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
            }
        }
    }

    private var isWorking: Bool {
        if case .working = model.pairingPhase { return true }
        return false
    }

    private func submitTyped() {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { model.pair(uri: text) }
    }

    @ViewBuilder private var scanner: some View {
        if camera == .authorized, AVCaptureDevice.default(for: .video) != nil {
            ScannerView { model.scanned($0) }
        } else {
            ZStack {
                Rectangle().fill(.quaternary)
                VStack(spacing: 12) {
                    Image(systemName: "camera").font(.system(size: 40, weight: .light)).foregroundStyle(.secondary)
                    if camera == .denied || camera == .restricted {
                        Text("Remote Draw may not use the camera.").multilineTextAlignment(.center)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    } else if camera == .authorized {
                        Text("No camera here. Paste the pairing link below.").multilineTextAlignment(.center)
                    }
                }
                .foregroundStyle(.secondary).padding(24)
            }
        }
    }

    @ViewBuilder private var status: some View {
        switch model.pairingPhase {
        case .idle:
            EmptyView()
        case .working(let name):
            HStack(spacing: 10) { ProgressView(); Text("Connecting to \(name)…") }
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).multilineTextAlignment(.leading)
        }
    }
}

/// A live camera picture that reports the text of every QR code it sees.
private struct ScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {
        controller.onCode = onCode
    }
}

private final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "remote-draw.scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
        // The picture has to stay upright in every iPad orientation.
        let rotation = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: preview)
        self.rotation = rotation
        rotationObservation = rotation.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            DispatchQueue.main.async {
                guard let connection = self?.preview?.connection, connection.isVideoRotationAngleSupported(angle) else { return }
                connection.videoRotationAngle = angle
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [session] in if !session.isRunning { session.startRunning() } }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        sessionQueue.async { [session] in if session.isRunning { session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        for case let code as AVMetadataMachineReadableCodeObject in objects {
            if let text = code.stringValue { onCode?(text) }
        }
    }
}
