// The view-model (like a WPF ViewModel): reads the agent's state every few seconds and runs its commands.
import AdminCore
import Foundation
import Observation

@MainActor @Observable
final class AgentModel {
    private(set) var snapshot = Snapshot()
    private(set) var command: AgentCommand?
    /// The last thing that went wrong running a command, shown in the menu and on the Status page.
    var lastError: String?
    let locations = Locations.standard

    var state: AgentState { AgentState(snapshot) }

    init() {
        refresh()
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                self?.refresh()
            }
        }
    }

    func refresh() {
        command = AgentCommand.fromLaunchAgent(at: locations.launchAgent)
        let loc = locations
        Task.detached {
            let s = Snapshot.read(loc)
            await MainActor.run { [weak self] in self?.snapshot = s }
        }
    }

    /// Run the whole pipeline now, ignoring the idle checks and any pause (like `broadsheet run --force`).
    func runNow() {
        guard let command else { lastError = "The agent isn't scheduled, so Admin can't find it. In Terminal: broadsheet install"; return }
        do {
            try command.start(["run", "--force"])
            lastError = nil
        } catch {
            lastError = "Couldn't start a run: \(error.localizedDescription)"
        }
        Task { try? await Task.sleep(for: .seconds(1)); refresh() }
    }

    /// "1h", "tomorrow" or "off".
    func pause(_ how: String) {
        guard let command else { lastError = "The agent isn't scheduled, so Admin can't find it. In Terminal: broadsheet install"; return }
        Task {
            do {
                let r = try await command.run(["pause", how])
                lastError = r.ok ? nil : r.output.trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                lastError = "Couldn't pause: \(error.localizedDescription)"
            }
            refresh()
        }
    }
}
