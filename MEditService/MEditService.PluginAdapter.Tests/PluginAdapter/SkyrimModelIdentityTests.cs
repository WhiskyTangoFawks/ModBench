using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class SkyrimModelIdentityTests
{
    [Fact]
    public void DivergenceFrom_WhenATranslatedStringReadsItsLanguagesInAnotherOrder_ReturnsNull_SinceMutagenHoldsThemAsADictionary()
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-languages-");
        var original = WriteWithArchivedStrings(Path.Combine(scratch, "original"), "Tür", Language.English, Language.German);
        var recompiled = WriteWithArchivedStrings(Path.Combine(scratch, "recompiled"), "Tür", Language.German, Language.English);

        Assert.Null(DivergenceBetween(original, recompiled));
    }

    [Fact]
    public void DivergenceFrom_WhenOneLanguageOfATranslatedStringDiffers_NamesItsLanguage()
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-languages-");
        var original = WriteWithArchivedStrings(Path.Combine(scratch, "original"), "Tür", Language.English, Language.German);
        var recompiled = WriteWithArchivedStrings(Path.Combine(scratch, "recompiled"), "Tor", Language.German, Language.English);

        Assert.Contains("field 'Name.Values[\"German\"]' changed", DivergenceBetween(original, recompiled), StringComparison.Ordinal);
    }

    [Fact]
    public void DivergenceFrom_NamesAnAllowListedFieldOfSkyrimsHeader()
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-skyrim-header-");
        var original = Write(Path.Combine(scratch, "original"), header => header.Author = "Original");
        var recompiled = Write(Path.Combine(scratch, "recompiled"), header => header.Author = "Corrupted");

        Assert.Contains("'Author'", DivergenceBetween(original, recompiled), StringComparison.Ordinal);
    }

    private static string Write(string folder, Action<SkyrimModHeader> setHeader)
    {
        var mod = new SkyrimMod(ModKey.FromFileName("Fixture.esp"), SkyrimRelease.SkyrimSE);
        setHeader(mod.ModHeader);
        var path = Path.Combine(Directory.CreateDirectory(folder).FullName, "Fixture.esp");
        ((IModGetter)mod).WriteToBinary(path);
        return path;
    }

    private static string? DivergenceBetween(string original, string recompiled) =>
        TestAdapters.Mutagen().DivergenceFrom(
            "Fixture.esp", original, recompiled, EmptyLoadOrder.Of(GameRelease.SkyrimSE),
            HandedStrings.Beside(Path.GetDirectoryName(original) ?? throw new ArgumentException("No folder.", nameof(original)))).Answered();

    private static string WriteWithArchivedStrings(string folder, string german, params Language[] archiveOrder)
    {
        Directory.CreateDirectory(folder);
        var mod = new SkyrimMod(ModKey.FromFileName("Fixture.esp"), SkyrimRelease.SkyrimSE) { UsingLocalization = true };
        var door = mod.Doors.AddNew("Door");
        door.Name = new TranslatedString(Language.English, [new(Language.English, "Door"), new(Language.German, german)]);
        var path = Path.Combine(folder, "Fixture.esp");
        ((IModGetter)mod).WriteToBinary(path);
        var strings = Path.Combine(folder, "Strings");
        StringsArchive.Pack(
            archiveOrder.SelectMany(language => Directory.EnumerateFiles(strings, $"*_{language}.*")),
            Path.Combine(folder, "Fixture.bsa"));
        Directory.Delete(strings, recursive: true);
        return path;
    }
}
