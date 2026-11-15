import Foundation
import Argmax

// Argmax Pro SDK licensing. The API key is read from ARGMAX_API_KEY, or from the gitignored
// `.env` at the repo root. It is never logged or written anywhere else.
//
// Wi-Fi off: the SDK caches a signed license token after the first online check. Run
// `kindred-capture license` once with Wi-Fi on before the demo and check `licenseTokenExpiresAt`.

/// ARGMAX_API_KEY from the environment, else from the nearest `.env` above the working directory
/// or above the binary (capture/.build/release/kindred-capture → repo root).
func argmaxApiKey() -> String? {
    if let key = env("ARGMAX_API_KEY") { return key }
    let starts = [URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
                  URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()]
    for start in starts {
        var dir = start
        for _ in 0..<6 {
            let file = dir.appendingPathComponent(".env")
            if let text = try? String(contentsOf: file, encoding: .utf8) {
                for line in text.split(whereSeparator: \.isNewline) {
                    let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                    if parts.count == 2, parts[0] == "ARGMAX_API_KEY", !parts[1].isEmpty {
                        return parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                    }
                }
            }
            dir = dir.deletingLastPathComponent()
        }
    }
    return nil
}

/// Set once by setupPro(). When false, everything falls back to the open-source SDK.
nonisolated(unsafe) var proEnabled = false

/// Register the Pro license. Returns true if Pro features are available.
@discardableResult
func setupPro() async -> Bool {
    guard env("KINDRED_NO_PRO") == nil else { Out.log("argmax pro: disabled (KINDRED_NO_PRO)"); return false }
    guard let key = argmaxApiKey() else { Out.log("argmax pro: no ARGMAX_API_KEY; using open-source SDK"); return false }
    // Runtime API keys start with "ax_". The "axst_" token is only for the Swift package registry,
    // and ArgmaxConfig traps (crashes the process) if handed one — so check before calling it.
    guard key.hasPrefix("ax_") else {
        Out.log("argmax pro: ARGMAX_API_KEY is not a runtime API key (must start with \"ax_\"; \"axst_\" is the registry token). Using open-source SDK.")
        return false
    }
    let config = ArgmaxConfig(apiKey: key)
    config.licenseStatusCallback = { update in
        Out.log("argmax pro license: \(update.licenseEvent.rawValue) → \(update.result.rawValue)\(update.errorMessage.map { " (\($0))" } ?? "")")
    }
    await ArgmaxSDK.with(config)
    let info = await ArgmaxSDK.licenseInfo()
    proEnabled = info.proAccess
    Out.log("argmax pro: \(info.proAccess ? "enabled" : "NOT enabled — using open-source SDK")")
    return info.proAccess
}

/// `kindred-capture license` — prints license status as JSON (no key). Run once online before going offline.
func printLicense() async {
    guard await setupPro() || ArgmaxSDK.cachedConfig != nil else { Out.send(["proAccess": false]); return }
    let info = await ArgmaxSDK.licenseInfo()
    let f = ISO8601DateFormatter()
    Out.send(["proAccess": info.proAccess, "subscriptionType": info.subscriptionType, "features": info.features,
              "licenseTokenExpiresAt": info.licenseTokenExpiresAt.map(f.string), "accessTokenExpiresAt": info.accessTokenExpiresAt.map(f.string),
              "lastSuccessfulLicense": info.lastSuccessfulLicense.map(f.string),
              "lastResult": info.lastLicenseUpdate.map { "\($0.licenseEvent.rawValue): \($0.result.rawValue)" }])
}
