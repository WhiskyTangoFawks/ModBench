using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Index.Tests.Plugins;

public sealed class LoadOrderLocalizedTests
{
    [Fact]
    public void ALocalizedDataDirectoryPlugin_IndexesItsRealStringInsteadOfThrowingOrReadingEmpty()
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
            File.WriteAllBytes(Path.Combine(data.DataFolder, "UnrelatedMod - Main.ba2"), []);

            using var index = Indexes.Open(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            Assert.Empty(index.Status.Failures);

            var detail = index.CopyIn(doorFormKey.ToString(), new PluginAddress("Fixture.esp", PluginOrigin.DataDirectory));
            Assert.NotNull(detail);
            Assert.Contains(detail.Fields, f => f.Value?.ToString()?.Contains("The Big Door") == true);
        }
    }

    [Fact]
    public void ALocalizedOverwritePlugin_ReadsItsOwnStrings_NotTheGamesDataFolder()
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
            File.WriteAllBytes(Path.Combine(overwriteFolder, "UnrelatedMod - Main.ba2"), []);
            Assert.False(Directory.Exists(Path.Combine(fx.GameDirectory, "Strings")), "the fixture must carry no Data/Strings to fall back to");

            using var index = Indexes.Open(holder);
            index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            Assert.Empty(index.Status.Failures);

            var detail = index.CopyIn(doorFormKey.ToString(), new PluginAddress("Fixture.esp", PluginOrigin.Overwrite));
            Assert.NotNull(detail);
            Assert.Contains(detail.Fields, f => f.Value?.ToString()?.Contains("The Overwrite Door") == true);
        }
    }
}
