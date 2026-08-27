using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Session;

/// <summary>
/// #515 AC3: session ingest's binary path (<see cref="GameSession.OpenAll"/> — the "binary is for
/// untracked plugins" overlay, ADR-0041's #452 amendment) shows a Localized plugin's real strings
/// rather than throwing or reading empty ones. A Data-directory-origin plugin, deliberately: this is
/// the one case with no mod folder at all, where <see cref="Source.LocalizedStrings.ForRead"/> must
/// fall back to the game Data folder rather than a mod folder that does not exist.
/// </summary>
public sealed class GameSessionLocalizedTests
{
    // Rival observed by hand before this fix (not committed): with GameSession's three
    // ModFactory.ImportGetter call sites reverted to pass no BinaryReadParameters, this test fails on
    // the LoadFailures assertion below, not the string-content one — GameSession.OpenAll never lets a
    // single plugin's open failure escape (it records a PluginLoadFailure and skips the plugin
    // instead), so the raw exception never reaches this test directly. The recorded reason is
    // "RecordException: Could not determine plugin listings path for Fallout4...", the same defect
    // #515 reports, now surfacing as a silently-skipped plugin instead of a thrown exception.
    [Fact]
    public void Load_ALocalizedPlugin_IndexesItsRealStringInsteadOfThrowingOrReadingEmpty()
    {
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("session-localized")
            .WithPlugin("Fixture.esp", mod =>
            {
                var door = mod.Doors.AddNew("MainDoor");
                door.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                doorFormKey = door.FormKey;
            })
            .Build();
        using (data)
        {
            // Forces the exact branch that needs a plugin-listings path (see TrackServiceTests'
            // identically-purposed fixture file for the full mechanism): Mutagen's own archive-listing
            // check runs for every ".ba2" the scan finds before it even asks whether the file is
            // applicable to this plugin's ModKey, so an unrelated name still reproduces the crash.
            File.WriteAllBytes(Path.Combine(data.DataFolder, "UnrelatedMod - Main.ba2"), []);

            var reflector = SharedSchemaReflector.Instance;
            using var manager = new SessionManager(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            // GameSession.OpenAll never lets one plugin's open failure escape — it records it as a
            // PluginLoadFailure and skips the plugin instead. Asserted directly, not just implied by
            // GetDocument coming back null below: a skipped plugin is the actual, precise shape the
            // pre-fix defect takes here (confirmed by hand: reverting GameSession's own strings
            // parameters reports "RecordException: Could not determine plugin listings path for
            // Fallout4...").
            Assert.Empty(manager.Session!.LoadFailures);

            var detail = manager.Repository!.GetDocument(doorFormKey.ToString(), new PluginKey("Fixture.esp", "Data"))!;
            Assert.Contains(detail.Fields, f => f.Value != null && f.Value.ToString()!.Contains("The Big Door"));
        }
    }
}
