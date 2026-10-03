using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Index.Tests.Plugins;

/// <summary>A Data-directory-origin plugin, deliberately: an origin with no mod folder, whose
/// <see cref="MEditService.PluginAdapter.PluginStrings"/> are the game Data folder's.</summary>
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

            using var manager = Indexes.Open(holder);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            // Asserted directly, not just implied by GetDocument coming back null below: a
            // silently-skipped plugin is the precise shape the defect takes here.
            Assert.Empty(manager.Status.Failures);

            var reads = manager.RequireReads();
            var detail = reads.GetDocument(doorFormKey.ToString(), new PluginAddress("Fixture.esp", "Data"));
            Assert.NotNull(detail);
            Assert.Contains(detail.Fields, f => f.Value?.ToString()?.Contains("The Big Door") == true);
        }
    }

    [Fact]
    public void Load_ALocalizedOverwritePlugin_ReadsItsOwnStrings_NotTheGamesDataFolder()
    {
        var holder = new LoadOrderHolder();
        FormKey doorFormKey = default;
        var fx = new PluginFixtureBuilder("load-order-localized-overwrite")
            .WithPlugin("Fixture.esp", mod =>
            {
                var door = mod.Doors.AddNew("MainDoor");
                door.Name = new TranslatedString(Language.English, "The Overwrite Door");
                mod.UsingLocalization = true;
                doorFormKey = door.FormKey;
            }, origin: PluginOrigin.Overwrite)
            .BuildScattered();
        using (fx)
        {
            var overwriteFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
            // Same archive-listing forcing as the Data case above, over the plugin's own folder.
            File.WriteAllBytes(Path.Combine(overwriteFolder, "UnrelatedMod - Main.ba2"), []);
            Assert.False(Directory.Exists(Path.Combine(fx.GameDirectory, "Strings")), "the fixture must carry no Data/Strings to fall back to");

            using var manager = Indexes.Open(holder);
            manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            Assert.Empty(manager.Status.Failures);

            var reads = manager.RequireReads();
            var detail = reads.GetDocument(doorFormKey.ToString(), new PluginAddress("Fixture.esp", PluginOrigin.Overwrite));
            Assert.NotNull(detail);
            Assert.Contains(detail.Fields, f => f.Value?.ToString()?.Contains("The Overwrite Door") == true);
        }
    }
}
