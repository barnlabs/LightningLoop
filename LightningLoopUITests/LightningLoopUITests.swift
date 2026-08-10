import XCTest

final class LightningLoopUITests: XCTestCase {
    private var app: XCUIApplication!
    private var isolatedHome: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        isolatedHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("LightningLoopUITests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: isolatedHome, withIntermediateDirectories: true)

        let homePath = isolatedHome.path
        let application = MainActor.assumeIsolated {
            let application = XCUIApplication()
            application.launchEnvironment["LIGHTNINGLOOP_UI_TESTING"] = "1"
            application.launchEnvironment["CFFIXED_USER_HOME"] = homePath
            application.launchArguments += ["--ui-testing"]
            application.launch()
            return application
        }
        app = application
        let windowOpened = MainActor.assumeIsolated {
            application.windows.firstMatch.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(windowOpened)
    }

    override func tearDownWithError() throws {
        if let app {
            MainActor.assumeIsolated {
                app.terminate()
            }
        }
        if let isolatedHome {
            try? FileManager.default.removeItem(at: isolatedHome)
        }
    }

    @MainActor
    func testPrimaryJourneySupportsKeyboardAndHasStableAccessibilitySurface() throws {
        let title = app.staticTexts["lightningloop.hero.title"]
        let editor = app.textViews["goal.editor"]
        let attach = app.buttons["attach.images"]
        let start = app.buttons["start.clarification"]
        let artifactWorkspace = app.buttons["artifact.workspace.choose"]

        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(editor.exists)
        XCTAssertTrue(app.staticTexts["goal.editor.guidance"].exists)
        XCTAssertTrue(attach.exists)
        XCTAssertTrue(start.exists)
        XCTAssertTrue(artifactWorkspace.exists)
        XCTAssertFalse(artifactWorkspace.isEnabled, "The isolated no-harness UI test must not grant workspace writes.")
        XCTAssertTrue(app.descendants(matching: .any)["pipeline.overview"].exists)

        editor.click()
        editor.typeText("Create an accessible BarnLabs launch brief")
        XCTAssertFalse(start.isEnabled, "The isolated UI test must not inherit a real Keychain credential.")

        app.typeKey("n", modifierFlags: [.command])
        XCTAssertTrue(waitUntil(timeout: 3) { self.app.textViews["goal.editor"].value as? String != "Create an accessible BarnLabs launch brief" })

        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "LightningLoop-main-window"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testEvidenceLabClearlyLabelsTheNonVerificationFixture() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        app.terminate()
        app.launchEnvironment["LIGHTNINGLOOP_EVIDENCE_DEMO_ROOT"] = repositoryRoot.path
        app.launch()

        let evidenceLab = app.descendants(matching: .any)["evidence.lab"]
        XCTAssertTrue(evidenceLab.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Evidence Lab"].exists)
        XCTAssertTrue(app.staticTexts["UI TEST FIXTURE"].exists)
        XCTAssertTrue(app.staticTexts["NOT CURRENT VERIFICATION"].exists)
        XCTAssertFalse(app.staticTexts["VERIFIED"].exists)
        XCTAssertFalse(app.staticTexts["PROVED"].exists)
        XCTAssertTrue(app.staticTexts["Sandboxed script runner"].exists)
        XCTAssertTrue(app.staticTexts["Static picture evidence"].exists)
        let genericButton = app.buttons["Open in Default App"]
        for _ in 0..<8 where !genericButton.exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(genericButton.exists)

        let screenshot = app.windows.firstMatch.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "LightningLoop-evidence-lab"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testDeterministicCoreStateSurfacesRemainExplicit() throws {
        relaunch(scenario: "working")
        XCTAssertTrue(app.staticTexts["Clarifying the outcome"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["cancel.current.run"].exists)
        keepScreenshot(named: "LightningLoop-working-fixture")

        relaunch(scenario: "blocked-history")
        XCTAssertTrue(app.staticTexts["Paused before a deliverable was produced"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Verify installer rollback"].exists)
        XCTAssertTrue(app.staticTexts["Write a concise project brief"].exists)
        XCTAssertTrue(app.staticTexts["blocked.recovery.guidance"].exists)
        XCTAssertTrue(app.buttons["open.settings.blocked"].exists)
        keepScreenshot(named: "LightningLoop-blocked-history-fixture")

        relaunch(scenario: "settings-model")
        XCTAssertTrue(app.descendants(matching: .any)["runtime.model.picker"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["settings.fixture.navigation"].exists)
        XCTAssertTrue(app.staticTexts["Gemma 4 31B"].exists)
        keepScreenshot(named: "LightningLoop-settings-model-fixture")

        relaunch(scenario: "settings-update")
        XCTAssertTrue(app.staticTexts["Automatic updates are off"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["settings.fixture.navigation"].exists)
        XCTAssertTrue(app.staticTexts["UNCONFIGURED"].exists)
        XCTAssertTrue(app.links["secure.update.guide"].exists)
        keepScreenshot(named: "LightningLoop-settings-update-fixture")
    }

    @MainActor
    private func relaunch(scenario: String) {
        app.terminate()
        app.launchEnvironment["LIGHTNINGLOOP_UI_SCENARIO"] = scenario
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 8))
    }

    @MainActor
    private func keepScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, condition: @MainActor @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return condition()
    }
}
