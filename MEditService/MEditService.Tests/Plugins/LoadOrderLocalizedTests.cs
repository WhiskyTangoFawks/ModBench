using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Plugins;

/// <summary>
/// Load order ingest's binary path (<see cref="LoadOrder.OpenAll"/> — the "binary is for
/// untracked plugins" overlay, ADR-0041) shows a Localized plugin's real strings
/// rather than throwing or reading empty ones. A Data-directory-origin plugin, deliberately: this is
/// the one case with no mod folder at all, where <see cref="Source.LocalizedStrings.ForRead"/> must
/// fall back to the game Data folder rather than a mod folder that does not exist.
/// </summary>
public sealed class LoadOrderLocalizedTests
{
    // With LoadOrder's three ModFactory.ImportGetter call sites passing no BinaryReadParameters,
    // this test fails on the LoadFailures assertion below, not the string-content one —
    // LoadOrder.OpenAll never lets a single plugin's open failure escape (it records a
    // PluginLoadFailure and skips the plugin instead), so the defect ("RecordException: Could not
    // determine plugin listings path for Fallout4...") surfaces as a silently-skipped plugin, not
    // a thrown exception.
    [Fact]
    public void Load_ALocalizedPlugin_IndexesItsRealStringInsteadOfThrowingOrReadingEmpty()
    {
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("load-order-localized")
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
            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);

            // Asserted directly, not just implied by GetDocument coming back null below: a
            // silently-skipped plugin is the precise shape the defect takes here.
            Assert.Empty(manager.LoadOrder!.LoadFailures);

            var detail = manager.Reads!.GetDocument(doorFormKey.ToString(), new PluginKey("Fixture.esp", "Data"))!;
            Assert.Contains(detail.Fields, f => f.Value != null && f.Value.ToString()!.Contains("The Big Door"));
        }
    }
}
