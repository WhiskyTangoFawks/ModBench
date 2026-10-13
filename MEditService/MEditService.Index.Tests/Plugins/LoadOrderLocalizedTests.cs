using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
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

    [Fact]
    public void ALocalizedPluginMissingOneStringsFile_NamesThatFileOnItsName() =>
        Assert.Equal("Fixture_en.STRINGS", NameCheckErrorLeaving(["Fixture_en.ILSTRINGS", "Fixture_en.DLSTRINGS"]));

    [Fact]
    public void ALocalizedPluginMissingTwoStringsFiles_NamesBothOnItsName() =>
        Assert.Equal("Fixture_en.STRINGS, Fixture_en.DLSTRINGS", NameCheckErrorLeaving(["Fixture_en.ILSTRINGS"]));

    private static string? NameCheckErrorLeaving(string[] stringsFilesKept)
    {
        var holder = new LoadOrderHolder();
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("load-order-localized-missing")
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
            var strings = Path.Combine(data.DataFolder, "Strings");
            Directory.Delete(strings, recursive: true);
            Directory.CreateDirectory(strings);
            foreach (var kept in stringsFilesKept) File.WriteAllBytes(Path.Combine(strings, kept), []);

            using var index = Indexes.Open(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var detail = index.CopyIn(doorFormKey.ToString(), new PluginAddress("Fixture.esp", PluginOrigin.DataDirectory));
            return Assert.Single(detail.Require().Fields, f => f.Metadata.Name == "Name").CheckError;
        }
    }

    [Fact]
    public void ComparingCopiesOfARecordWhoseStringsFilesAreMissing_CarriesEachColumnsStringsFileOnItsName()
    {
        var holder = new LoadOrderHolder();
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("load-order-localized-missing-compare")
            .WithPlugin("Fixture.esp", mod =>
            {
                var door = mod.Doors.AddNew("MainDoor");
                door.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                doorFormKey = door.FormKey;
            })
            .WithPlugin("Other.esp", (mod, built) =>
            {
                mod.UsingLocalization = true;
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = built[0].ModKey });
                var copy = (Mutagen.Bethesda.Fallout4.Door)built[0].Doors.Single().DeepCopy();
                copy.Name = new TranslatedString(Language.English, "The Other Door");
                mod.Doors.Set(copy);
            })
            .Build();
        using (data)
        {
            Directory.Delete(Path.Combine(data.DataFolder, "Strings"), recursive: true);

            using var index = Indexes.Open(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var compare = index.Queries.GetCompare(doorFormKey.ToString()).Value().Require();
            var name = Assert.Single(compare.Diffs, diff => diff.FieldName == "Name");
            Assert.Equal(
                ["Fixture_en.STRINGS, Fixture_en.ILSTRINGS, Fixture_en.DLSTRINGS", "Other_en.STRINGS, Other_en.ILSTRINGS, Other_en.DLSTRINGS"],
                name.CheckErrors.Require().OrderBy(entry => entry.Key, StringComparer.Ordinal).Select(entry => entry.Value));
        }
    }
}
