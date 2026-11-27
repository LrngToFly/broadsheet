// swift-tools-version: 6.0
// Broadsheet Admin (docs/phase-3.md): a menu-bar app for the Mac mini. Build and install with ./build.sh;
// open this folder in Xcode to edit it.
import PackageDescription

let package = Package(
    name: "BroadsheetAdmin",
    platforms: [.macOS(.v15)],
    targets: [
        // Plain logic, no UI: reading the database, finding the agent, working out what it's doing. Tested.
        .target(name: "AdminCore", linkerSettings: [.linkedLibrary("sqlite3")]),
        // The SwiftUI app: the menu-bar item and the Admin window.
        .executableTarget(name: "BroadsheetAdmin", dependencies: ["AdminCore"]),
        .testTarget(name: "AdminCoreTests", dependencies: ["AdminCore"]),
    ]
)
