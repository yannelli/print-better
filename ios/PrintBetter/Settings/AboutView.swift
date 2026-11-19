import SwiftUI

/// How printing from this iPhone works, in a few short sections.
struct AboutView: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: 8) {
                    BrandMark(size: 72)
                    Text("Print Better").font(.title2.bold())
                    Text("Version \(AppConfig.version) (\(AppConfig.build))").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)

            HelpSection(title: "How printing works") {
                Text("Print Better sends what you print to your Print Better server. The computer or Raspberry Pi connected to the printer picks it up and prints it, so this iPhone can be anywhere with internet.")
            }
            HelpSection(title: "Print from other apps") {
                Text("1. In Safari, Photos, Files or another app, tap Share.")
                Text("2. Tap Print Better. If it isn't in the row of apps, swipe to the end of the row, tap More, then tap Print Better.")
                Text("3. Choose a printer and settings, then tap Print.")
                Text("Safari pages become a PDF first, so they print the way Safari lays them out.").foregroundStyle(.secondary)
            }
            HelpSection(title: "Printing at home") {
                Text("When this iPhone is on the same Wi-Fi as a computer that shares its printers on the local network, those printers also show in the iPhone's own print menu (tap Share, then Print).")
                Text("To turn this on, open the computer under Devices in the web app and turn on Share printers on the local network.")
            }
            HelpSection(title: "If a document doesn't print") {
                Text("Still waiting: check that the computer connected to the printer is on and online. The job prints when it's back.")
                Text("You can't print to this printer from this iPhone: your workspace limits which devices can use it. Ask an admin to allow this iPhone.")
                Text("Printed with a problem: the job finished, but the printer or its computer reported a problem. The job shows the message.")
            }
        }
        .navigationTitle("About and Help")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct HelpSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        Section(title) {
            VStack(alignment: .leading, spacing: 10) { content }
                .padding(.vertical, 4)
        }
    }
}
