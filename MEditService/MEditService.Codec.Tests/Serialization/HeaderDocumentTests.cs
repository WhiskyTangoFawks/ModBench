using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Codec.Tests.Serialization;

public sealed class HeaderDocumentTests
{
    private static Fallout4Mod PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("HeaderDoc.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";
        const string NonAsciiBecauseTheByteComparisonsAreTheOnlyPlaceAnEncodingDifferenceBetweenTheTwoProducersCouldShow = "Cut-down slice — ünïcode, em—dash";
        mod.ModHeader.Description = NonAsciiBecauseTheByteComparisonsAreTheOnlyPlaceAnEncodingDifferenceBetweenTheTwoProducersCouldShow;
        mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Master | Fallout4ModHeader.HeaderFlag.Localized;
        mod.ModHeader.Stats.NumRecords = 5;
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Other.esm") });
        mod.ModHeader.SetOverriddenForms([new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x123)]);

        mod.Weapons.AddNew().EditorID = "SomeWeapon";
        mod.Npcs.AddNew().EditorID = "SomeNpc";
        var quest = new Quest(mod) { EditorID = "SomeQuest" };
        var topic = new DialogTopic(mod) { EditorID = "SomeTopic" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "SomeResponse" });
        quest.DialogTopics.Add(topic);
        mod.Quests.Add(quest);
        mod.ModHeader.Stats.NextFormID = 0x900;
        return mod;
    }

    [Fact]
    public async Task AHeadersDocument_IsTheBytesTheWholeModDoorWritesForIt_ForAModWithRealGroups_ComparedAsTextForAReadableFailureThenAsBytesBecauseATextOnlyCompareCannotSeeABomOrEncodingDifference()
    {
        var mod = PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords();

        using var dir = new ScratchDirectory("medit-headerdoc-");
        await Fallout4WholeMod.Serialize(mod, dir.Path);
        var wholeModRoot = StripCarriageReturns(await File.ReadAllBytesAsync(Path.Combine(dir.Path, "RecordData.json")));

        var produced = HeaderDocument.Write(mod);

        Assert.Equal(Encoding.UTF8.GetString(wholeModRoot), Encoding.UTF8.GetString(produced));
        Assert.Equal(wholeModRoot, produced);

        Assert.True(
            Directory.EnumerateFiles(dir.Path, "*", SearchOption.AllDirectories).Count() > 1,
            "fixture wrote no child records — the clone shortcut is untested by this comparison.");
    }

    [Fact]
    public void ANextObjectIdOfZero_SurvivesTheRoundTripThroughItsDocument()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ZeroNext.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Stats.NextFormID = 0;

        var body = HeaderDocument.Write(mod);

        Assert.Equal(0u, HeaderDocument.NextObjectId(body, GameRelease.Fallout4));
        Assert.Equal(body, HeaderDocument.Write(HeaderDocument.Read(body, GameRelease.Fallout4)));
    }

    [Fact]
    public void AHeadersDocument_IsCanonicalBytes_NoCarriageReturnNoTrailingNewlineNoBom()
    {
        var produced = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());

        Assert.DoesNotContain((byte)'\r', produced);
        Assert.Equal((byte)'}', produced[^1]);
        Assert.False(produced.Length >= 3 && produced[0] == 0xEF && produced[1] == 0xBB && produced[2] == 0xBF,
            "the document must carry no UTF-8 BOM.");
    }

    [Fact]
    public void AHeadersDocument_HoldsNoMastersOrRecordCount_BecauseEveryWriteDerivesThemFromContent()
    {
        var body = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());

        using var document = JsonDocument.Parse(body);
        var header = document.RootElement.GetProperty("ModHeader");
        Assert.False(header.TryGetProperty("MasterReferences", out _));
        Assert.False(header.GetProperty("Stats").TryGetProperty("NumRecords", out _));
    }

    [Fact]
    public void AHeadersNextObjectId_IsTheOneTheModHeld()
    {
        var body = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());

        Assert.Equal(0x900u, HeaderDocument.NextObjectId(body, GameRelease.Fallout4));
    }

    [Fact]
    public void SettingTheNextObjectId_ChangesTheCounterAndNothingElse()
    {
        var body = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());

        var moved = HeaderDocument.WithNextObjectId(body, GameRelease.Fallout4, 0xA42);

        Assert.Equal(0xA42u, HeaderDocument.NextObjectId(moved, GameRelease.Fallout4));
        Assert.Equal(
            Encoding.UTF8.GetString(body).Replace("2304", "2626", StringComparison.Ordinal),
            Encoding.UTF8.GetString(moved));
    }

    [Fact]
    public void AHeadersDocument_ReadsBackEveryHeaderFieldItHolds_AndIsWrittenAgainAsTheSameBytes()
    {
        var mod = PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords();
        var body = HeaderDocument.Write(mod);

        var readBack = (IFallout4ModGetter)HeaderDocument.Read(body, GameRelease.Fallout4);

        Assert.Equal(mod.ModKey, readBack.ModKey);
        Assert.Equal(mod.GameRelease, readBack.GameRelease);
        Assert.Equal(mod.ModHeader.Author, readBack.ModHeader.Author);
        Assert.Equal(mod.ModHeader.Description, readBack.ModHeader.Description);
        Assert.Equal(mod.ModHeader.Flags, readBack.ModHeader.Flags);
        Assert.Equal(mod.ModHeader.Stats.Version, readBack.ModHeader.Stats.Version);

        Assert.Equal(body, HeaderDocument.Write(readBack));
    }

    [Fact]
    public void AHeaderDocumentNamingAnotherGame_IsRefused()
    {
        var fallout4 = Encoding.UTF8.GetString(HeaderDocument.Write(new Fallout4Mod(ModKey.FromFileName("Other.esp"), Fallout4Release.Fallout4)));
        var skyrim = fallout4.Replace("\"GameRelease\": \"Fallout4\"", "\"GameRelease\": \"SkyrimSE\"", StringComparison.Ordinal);

        Assert.Throws<FilePathedException>(() => HeaderDocument.Read(Encoding.UTF8.GetBytes(skyrim), GameRelease.Fallout4));
    }

    [Fact]
    public void AHeaderDocument_ReadsAsAModWithNoRecords()
    {
        var readBack = HeaderDocument.Read(HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords()), GameRelease.Fallout4);

        Assert.Empty(readBack.EnumerateMajorRecords());
    }

    [Fact]
    public void WritingAndReadingAHeader_CreatesNothingOnDisk()
    {
        var before = Directory.EnumerateFileSystemEntries(Path.GetTempPath(), "medit-header-*").ToHashSet(StringComparer.Ordinal);

        var body = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());
        HeaderDocument.Read(body, GameRelease.Fallout4);

        var after = Directory.EnumerateFileSystemEntries(Path.GetTempPath(), "medit-header-*").ToHashSet(StringComparer.Ordinal);
        Assert.Empty(after.Except(before, StringComparer.Ordinal));
    }

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}
