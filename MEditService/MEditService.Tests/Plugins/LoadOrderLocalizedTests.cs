using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Plugins;

/// <summary>A Data-directory-origin plugin, deliberately: the one case with no mod folder, where
/// <see cref="MEditService.PluginAdapter.PluginStrings"/> must fall back to the game Data
/// folder.</summary>
public sealed class LoadOrderLocalizedTests
{
    // LoadOrderSnapshot.OpenAll never lets a plugin's open failure escape, recording a PluginLoadFailure and
    // skipping it, so the defect surfaces as a silently-skipped plugin rather than a throw.
    [Fact]
    public void Load_ALocalizedPlugin_IndexesItsRealStringInsteadOfThrowingOrReadingEmpty()
    {
        var holder = new LoadOrderHolder();
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
            // Mutagen's archive-listing check runs for every ".ba2" the scan finds before asking whether the
            // file applies to this plugin's ModKey, so an unrelated name still forces the branch that needs a
            // plugin-listings path.
            File.WriteAllBytes(Path.Combine(data.DataFolder, "UnrelatedMod - Main.ba2"), []);

            var reflector = SharedSchemaReflector.Instance;
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            // Asserted directly, not just implied by GetDocument coming back null below: a
            // silently-skipped plugin is the precise shape the defect takes here.
            Assert.Empty(manager.Status.Failures);

            var detail = manager.Reads!.GetDocument(doorFormKey.ToString(), new PluginKey("Fixture.esp", "Data"))!;
            Assert.Contains(detail.Fields, f => f.Value != null && f.Value.ToString()!.Contains("The Big Door"));
        }
    }
}
