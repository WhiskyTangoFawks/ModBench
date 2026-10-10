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

        Assert.Null(DivergenceBetween(original, recompiled, scratch));
    }

    [Fact]
    public void DivergenceFrom_WhenOneLanguageOfATranslatedStringDiffers_NamesItsLanguage()
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-languages-");
        var original = WriteWithArchivedStrings(Path.Combine(scratch, "original"), "Tür", Language.English, Language.German);
        var recompiled = WriteWithArchivedStrings(Path.Combine(scratch, "recompiled"), "Tor", Language.German, Language.English);

        Assert.Contains("field 'Name.Values[\"German\"]' changed", DivergenceBetween(original, recompiled, scratch), StringComparison.Ordinal);
    }

    public static TheoryData<string, Action<SkyrimModHeader>> AllowListedHeaderFieldCorruptions => new()
    {
        { "TypeOffsets", h => h.TypeOffsets = new byte[] { 9, 9, 9 } },
        { "Deleted", h => h.Deleted = new byte[] { 9, 9, 9 } },
        { "INTV", h => h.INTV = 99 },
        { "INCC", h => h.INCC = 2 },
        { "Author", h => h.Author = "Corrupted" },
        { "Description", h => h.Description = "Corrupted" },
    };

    [Theory]
    [MemberData(nameof(AllowListedHeaderFieldCorruptions))]
    public void DivergenceFrom_ForEveryAllowListedFieldOfSkyrimsHeader_NamesItWhenItAloneDiverges(
        string fieldName, Action<SkyrimModHeader> corrupt)
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-skyrim-header-");
        var original = Write(Path.Combine(scratch, "original"), _ => { });
        var recompiled = Write(Path.Combine(scratch, "recompiled"), corrupt);

        Assert.Contains($"'{fieldName}'", DivergenceBetween(original, recompiled, scratch), StringComparison.Ordinal);
    }

    private static string Write(string folder, Action<SkyrimModHeader> setHeader)
    {
        var mod = new SkyrimMod(ModKey.FromFileName("Fixture.esp"), SkyrimRelease.SkyrimSE);
        mod.ModHeader.TypeOffsets = new byte[] { 1, 2, 3 };
        mod.ModHeader.Deleted = new byte[] { 1, 2, 3 };
        mod.ModHeader.INTV = 1;
        mod.ModHeader.INCC = 1;
        mod.ModHeader.Author = "Original";
        mod.ModHeader.Description = "Original";
        setHeader(mod.ModHeader);
        var path = Path.Combine(Directory.CreateDirectory(folder).FullName, "Fixture.esp");
        ((IModGetter)mod).WriteToBinary(path);
        return path;
    }

    private static string? DivergenceBetween(string original, string recompiled, string scratch) =>
        TestAdapters.Mutagen().DivergenceFrom(
            "Fixture.esp", original, recompiled, GameRelease.SkyrimSE,
            new PluginStrings(Path.GetDirectoryName(original), scratch)).Answered();

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
